import { expect, test } from '@playwright/test';
import { startMockCalDavServer } from '@tasker/mock-caldav';
import { TestStepHelper } from '../helpers/test-step-helper';

const MILK_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VTODO',
  'UID:milk-1',
  'SUMMARY:Milk',
  'CATEGORIES:Dairy',
  'STATUS:NEEDS-ACTION',
  'END:VTODO',
  'END:VCALENDAR',
].join('\r\n');

test('US-005: User is offered to create a missing config JSON file on Nextcloud', async ({ page }, testInfo) => {
  const tester = new TestStepHelper(page, testInfo);
  tester.setMetadata(
    'Create Missing Config File',
    'As a user setting up a Config JSON path for the first time, if the file does not exist yet on Nextcloud (404), I want the app to offer to create it for me.',
  );

  const server = await startMockCalDavServer({
    port: 8791,
    auth: { username: 'alice', password: 'secret' },
    tasks: [{ uid: 'milk-1', calendarSlug: 'shopping', etag: 'etag-1', ics: MILK_ICS }],
    // Intentionally omit Notes/tasker-config.json so GET returns 404
    allowedOrigin: 'http://127.0.0.1:4173',
  });

  try {
    await page.goto('/');
    await page.getByLabel('Nextcloud URL').fill(server.url);
    await page.getByLabel('Username').fill('alice');
    await page.getByLabel('App password').fill('secret');
    await page.getByLabel('Config JSON path').fill('Notes/tasker-config.json');
    await page.getByRole('button', { name: 'Connect' }).click();

    await expect(page.getByTestId('missing-config-banner')).toBeVisible();
    await expect(page.getByTestId('calendar-select')).toBeVisible();

    await tester.step('missing-config-offered', {
      description: 'Connecting with a non-existent config path connects to CalDAV and offers to create the missing config JSON file',
      verifications: [
        {
          spec: 'Connection succeeds and shows missing config banner naming the path',
          check: async () => {
            await expect(page.getByTestId('connection-badge')).toContainText('Connected');
            await expect(page.getByTestId('missing-config-banner')).toContainText('Notes/tasker-config.json');
            await expect(page.getByTestId('create-config-btn')).toBeVisible();
          },
        },
        {
          spec: 'Remote file does not exist yet before user confirms',
          check: async () => {
            expect(server.backend.getFile('Notes/tasker-config.json')).toBeUndefined();
          },
        },
      ],
    });

    await page.getByTestId('create-config-btn').click();
    await expect(page.getByTestId('missing-config-banner')).toHaveCount(0);
    await expect(page.getByTestId('status')).toContainText('Created Notes/tasker-config.json on Nextcloud.');

    await tester.step('config-created', {
      description: 'Clicking Create config file writes tasker-config.json to Nextcloud WebDAV and dismisses the prompt',
      verifications: [
        {
          spec: 'Missing config banner is gone and confirmation status is shown',
          check: async () => {
            await expect(page.getByTestId('missing-config-banner')).toHaveCount(0);
            await expect(page.getByTestId('status')).toContainText('Created Notes/tasker-config.json on Nextcloud.');
          },
        },
        {
          spec: 'Mock WebDAV server now contains valid JSON with default categories',
          check: async () => {
            const raw = server.backend.getFile('Notes/tasker-config.json');
            expect(raw).toBeTruthy();
            const parsed = JSON.parse(raw!);
            expect(Array.isArray(parsed.categories)).toBe(true);
            expect(parsed.categories).toContain('Produce');
            expect(parsed.categories).toContain('Dairy');
          },
        },
      ],
    });

    // Re-connecting now finds the created config without showing the missing-config prompt
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByTestId('status')).toContainText('Connected as alice. Select a task list to load.');
    await expect(page.getByTestId('missing-config-banner')).toHaveCount(0);

    tester.generateDocs();
  } finally {
    await server.close();
  }
});
