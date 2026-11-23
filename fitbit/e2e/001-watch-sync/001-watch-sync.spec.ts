import { expect, test } from '@playwright/test';
import { startMockCalDavServer } from '@tasker/mock-caldav';
import { TestStepHelper } from '../helpers/test-step-helper';

function makeIcs(uid: string, summary: string, categories: string, extra?: string): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTODO',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    `CATEGORIES:${categories}`,
    'STATUS:NEEDS-ACTION',
    'LAST-MODIFIED:20260501T100000Z',
  ];
  if (extra) lines.push(extra);
  lines.push('END:VTODO', 'END:VCALENDAR');
  return lines.join('\r\n');
}

test('FIT-001: Versa 2 watch displays aisle-sorted list, toggles online, and reconciles offline check-offs across restart', async ({ page }, testInfo) => {
  const tester = new TestStepHelper(page, testInfo);
  tester.setMetadata(
    'Fitbit Versa 2 Grocery Sync',
    'As a Versa 2 user shopping at the store, I want my grocery list sorted by aisle on my wrist, check off items online or offline, and sync updates losslessly back to CalDAV.',
  );

  const server = await startMockCalDavServer({
    port: 8788,
    auth: { username: 'alice', password: 'secret' },
    tasks: [
      { uid: 'milk', calendarSlug: 'shopping', etag: 'e1', ics: makeIcs('milk', 'Milk', 'Dairy', 'X-PRESERVE:yes') },
      { uid: 'apples', calendarSlug: 'shopping', etag: 'e2', ics: makeIcs('apples', 'Apples', 'Produce', 'X-PRESERVE:yes') },
      { uid: 'bread', calendarSlug: 'shopping', etag: 'e3', ics: makeIcs('bread', 'Sourdough', 'Bakery') },
    ],
    files: [
      {
        path: 'Notes/tasker-config.json',
        content: JSON.stringify({
          defaultCalendarHref: '/remote.php/dav/calendars/alice/shopping/',
          aisles: ['Produce', 'Bakery', 'Dairy'],
        }),
        contentType: 'application/json',
      },
    ],
    allowedOrigin: 'http://127.0.0.1:4174',
  });

  try {
    const query = new URLSearchParams({
      app_server: server.url,
      app_username: 'alice',
      app_password: 'secret',
      app_config_path: 'Notes/tasker-config.json',
    });

    await page.goto(`/?${query.toString()}`);
    await expect(page.getByTestId('watch-status')).toHaveText('3 left');

    await tester.step('initial-sync', {
      description: 'Versa 2 loads tasks sorted by aisle walk order (Produce → Bakery → Dairy)',
      verifications: [
        {
          spec: 'Status shows 3 items left',
          check: async () => await expect(page.getByTestId('watch-status')).toHaveText('3 left'),
        },
        {
          spec: 'First tile is Apples (Produce), second is Sourdough (Bakery), third is Milk (Dairy)',
          check: async () => {
            await expect(page.getByTestId('watch-item-0')).toContainText('Apples');
            await expect(page.getByTestId('watch-item-0')).toContainText('Produce');
            await expect(page.getByTestId('watch-item-1')).toContainText('Sourdough');
            await expect(page.getByTestId('watch-item-2')).toContainText('Milk');
          },
        },
      ],
    });

    // Tap Apples on the watch while online
    await page.getByTestId('watch-item-0').click();
    await expect(page.getByTestId('watch-status')).toHaveText('2 left');

    await tester.step('toggled-online', {
      description: 'Tapping Apples checks it off on the watch and persists COMPLETED losslessly to CalDAV',
      verifications: [
        {
          spec: 'Apples tile is checked and status updates to 2 left',
          check: async () => {
            await expect(page.getByTestId('watch-item-0')).toHaveAttribute('data-checked', '1');
            await expect(page.getByTestId('watch-status')).toHaveText('2 left');
          },
        },
        {
          spec: 'Mock CalDAV server persisted COMPLETED and preserved X-PRESERVE property',
          check: async () => {
            const apples = server.backend.getTasks('shopping').find((t) => t.uid === 'apples');
            expect(apples?.ics).toContain('STATUS:COMPLETED');
            expect(apples?.ics).toContain('X-PRESERVE:yes');
          },
        },
      ],
    });

    // Simulate Bluetooth disconnect, check off Milk offline, then reload watch app (fs cache restart!)
    await page.evaluate(() => window.__fitbitHarness.setOnline(false));
    await expect(page.getByTestId('watch-status')).toHaveText('Offline');

    await page.getByTestId('watch-item-2').click();
    await expect(page.getByTestId('watch-status')).toHaveText('Offline (1 pending)');

    // Reload page with ?offline=1 to simulate watch app restart while Bluetooth is still disconnected
    await page.goto('/?offline=1');
    await expect(page.getByTestId('watch-status')).toHaveText('Offline (1 pending)');

    await tester.step('offline-restart-cache', {
      description: 'Offline toggle survives watch restart via Fitbit File Storage (fs) cache',
      verifications: [
        {
          spec: 'Status shows Offline (1 pending) after restart',
          check: async () => await expect(page.getByTestId('watch-status')).toHaveText('Offline (1 pending)'),
        },
        {
          spec: 'Milk remains checked from local fs cache',
          check: async () => await expect(page.getByTestId('watch-item-2')).toHaveAttribute('data-checked', '1'),
        },
      ],
    });

    // Reconnect Bluetooth → pending toggle flushes to CalDAV and reconciles
    await page.evaluate(() => window.__fitbitHarness.setOnline(true));
    await expect(page.getByTestId('watch-status')).toHaveText('1 left');

    await tester.step('reconnected-synced', {
      description: 'Reconnecting Bluetooth replays queued watch toggle and clears pending status',
      verifications: [
        {
          spec: 'Status clears pending count and shows 1 left',
          check: async () => await expect(page.getByTestId('watch-status')).toHaveText('1 left'),
        },
        {
          spec: 'Milk is persisted as COMPLETED in CalDAV with X-PRESERVE intact',
          check: async () => {
            const milk = server.backend.getTasks('shopping').find((t) => t.uid === 'milk');
            expect(milk?.ics).toContain('STATUS:COMPLETED');
            expect(milk?.ics).toContain('X-PRESERVE:yes');
          },
        },
      ],
    });

    tester.generateDocs();
  } finally {
    await server.close();
  }
});
