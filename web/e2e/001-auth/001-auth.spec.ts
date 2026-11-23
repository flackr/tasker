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

test('US-001: User enters credentials, selects a task list, and loads tasks', async ({ page }, testInfo) => {
  const tester = new TestStepHelper(page, testInfo);
  tester.setMetadata(
    'Authentication',
    'As a user, I want to connect to my Nextcloud server, choose a VTODO task list, and load my tasks.',
  );

  const server = await startMockCalDavServer({
    port: 8787,
    auth: { username: 'alice', password: 'secret' },
    tasks: [{ uid: 'milk-1', calendarSlug: 'shopping', etag: 'etag-1', ics: MILK_ICS }],
    allowedOrigin: 'http://127.0.0.1:4173',
  });

  try {
    await page.goto('/');

    await tester.step('initial-load', {
      description: 'User sees the connection form',
      verifications: [
        {
          spec: 'Nextcloud URL field visible',
          check: async () => await expect(page.getByLabel('Nextcloud URL')).toBeVisible(),
        },
        {
          spec: 'Connect button visible',
          check: async () => await expect(page.getByRole('button', { name: 'Connect' })).toBeVisible(),
        },
      ],
    });

    await page.getByLabel('Nextcloud URL').fill(server.url);
    await page.getByLabel('Username').fill('alice');
    await page.getByLabel('App password').fill('secret');
    await page.getByRole('button', { name: 'Connect' }).click();

    await expect(page.getByTestId('calendar-select')).toBeVisible();

    await tester.step('calendar-selection', {
      description: 'Only the VTODO-capable task list is offered',
      verifications: [
        {
          spec: 'Connection status shows Connected',
          check: async () => await expect(page.getByTestId('connection-badge')).toContainText('Connected'),
        },
        {
          spec: 'Shopping task list option present',
          check: async () => await expect(page.getByTestId('calendar-select')).toContainText('Shopping'),
        },
        {
          spec: 'Personal (VEVENT-only) calendar is filtered out',
          check: async () => await expect(page.getByTestId('calendar-select')).not.toContainText('Personal'),
        },
      ],
    });

    await page.getByRole('button', { name: 'Load tasks' }).click();

    await expect(page.getByTestId('status')).toContainText('Loaded 1 tasks');

    await tester.step('tasks-loaded', {
      description: 'Tasks load in the category-grouped task list after selecting a task list',
      verifications: [
        {
          spec: 'Status shows loaded task count',
          check: async () => await expect(page.getByTestId('status')).toContainText('Loaded 1 tasks'),
        },
        {
          spec: 'Task list shows the fetched task under its category',
          check: async () => await expect(page.getByTestId('task-list')).toContainText('Milk'),
        },
      ],
    });

    tester.generateDocs();
  } finally {
    await server.close();
  }
});
