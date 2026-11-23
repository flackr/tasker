import { expect, test } from '@playwright/test';
import { startMockCalDavServer } from '@tasker/mock-caldav';
import { TestStepHelper } from '../helpers/test-step-helper';

const MILK_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VTODO',
  'UID:milk',
  'SUMMARY:Milk',
  'CATEGORIES:Dairy',
  'STATUS:NEEDS-ACTION',
  'LAST-MODIFIED:20260501T100000Z',
  'END:VTODO',
  'END:VCALENDAR',
].join('\r\n');

test('US-003: User edits tasks offline and resolves a 412 conflict on reconnect', async ({ page, context }, testInfo) => {
  const tester = new TestStepHelper(page, testInfo);
  tester.setMetadata(
    'Offline Edits & Conflict Resolution',
    'As a shopper in a store with poor reception, I want offline changes queued locally and conflicts surfaced cleanly when I reconnect.',
  );

  const server = await startMockCalDavServer({
    auth: { username: 'alice', password: 'secret' },
    tasks: [{ uid: 'milk', calendarSlug: 'shopping', etag: 'etag-1', ics: MILK_ICS }],
    allowedOrigin: 'http://127.0.0.1:4173',
  });

  try {
    await page.goto('/');
    await page.getByLabel('Nextcloud URL').fill(server.url);
    await page.getByLabel('Username').fill('alice');
    await page.getByLabel('App password').fill('secret');
    await page.getByRole('button', { name: 'Connect' }).click();
    await page.getByRole('button', { name: 'Load tasks' }).click();
    await expect(page.getByTestId('status')).toContainText('Loaded 1 tasks');

    // Go offline
    await context.setOffline(true);
    await page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await expect(page.getByTestId('offline-banner')).toBeVisible();

    // Queue offline changes: add Eggs + check off Milk
    await page.getByLabel('New task').fill('Eggs');
    await page.getByLabel('Category').selectOption('Dairy');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByLabel('Mark Milk as completed').check();

    await expect(page.getByTestId('pending-badge')).toContainText('2 pending');

    await tester.step('offline-queued', {
      description: 'Offline banner and pending sync indicators show queued local edits',
      verifications: [
        {
          spec: 'Offline banner is visible',
          check: async () => await expect(page.getByTestId('offline-banner')).toBeVisible(),
        },
        {
          spec: 'Pending badge shows 2 queued changes',
          check: async () => await expect(page.getByTestId('pending-badge')).toContainText('2 pending'),
        },
        {
          spec: 'Newly added Eggs item renders immediately while offline',
          check: async () => await expect(page.getByTestId('task-list')).toContainText('Eggs'),
        },
      ],
    });

    // Simulate another device modifying Milk on the server while we were offline
    server.backend.setTask({
      uid: 'milk',
      calendarSlug: 'shopping',
      etag: 'etag-remote-2',
      ics: MILK_ICS.replace('SUMMARY:Milk', 'SUMMARY:Whole Milk (from phone)'),
    });

    // Reconnect and trigger automatic sync
    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));

    await expect(page.getByTestId('conflict-banner')).toBeVisible();

    await tester.step('conflict-detected', {
      description: 'Reconnecting syncs Eggs and surfaces the 412 conflict for Milk',
      verifications: [
        {
          spec: 'Conflict banner shows local and server versions for Milk',
          check: async () => {
            await expect(page.getByTestId('conflict-banner')).toContainText('Milk');
            await expect(page.getByTestId('conflict-banner')).toContainText('Whole Milk (from phone)');
          },
        },
        {
          spec: 'Non-conflicting offline item Eggs synced to server',
          check: async () => {
            const remote = server.backend.getTasks('shopping');
            expect(remote.some((t) => t.ics.includes('SUMMARY:Eggs'))).toBe(true);
          },
        },
      ],
    });

    // Resolve conflict by keeping local version
    await page.getByRole('button', { name: 'Keep Local' }).click();
    await expect(page.getByTestId('conflict-banner')).toBeHidden();
    await expect(page.getByTestId('pending-badge')).toBeHidden();

    await tester.step('conflict-resolved', {
      description: 'Resolving the conflict clears the banner and persists the chosen version to CalDAV',
      verifications: [
        {
          spec: 'Conflict banner is dismissed',
          check: async () => await expect(page.getByTestId('conflict-banner')).toBeHidden(),
        },
        {
          spec: 'Server reflects the kept local COMPLETED status for Milk',
          check: async () => {
            const milk = server.backend.getTasks('shopping').find((t) => t.uid === 'milk');
            expect(milk?.ics).toContain('STATUS:COMPLETED');
          },
        },
      ],
    });

    tester.generateDocs();
  } finally {
    await server.close();
  }
});
