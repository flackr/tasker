import { expect, test } from '@playwright/test';
import { startMockCalDavServer } from '@tasker/mock-caldav';
import { TestStepHelper } from '../helpers/test-step-helper';

function makeIcs(
  uid: string,
  summary: string,
  categories: string,
  status: string,
  lastModified: string,
): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTODO',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    `CATEGORIES:${categories}`,
    `STATUS:${status}`,
    `LAST-MODIFIED:${lastModified}`,
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n');
}

test('FIT-002: Newer server changes take precedence over older unsynced watch toggles on reconnect', async ({ page }, testInfo) => {
  const tester = new TestStepHelper(page, testInfo);
  tester.setMetadata(
    'Fitbit Watch Server-Preferred Reconciliation',
    'When the watch reconnects with unsynced offline toggles, newer changes on the server win while newer local watch changes sync up.',
  );

  const tWatchOffline = Date.parse('2026-05-01T10:05:00.000Z');
  const server = await startMockCalDavServer({
    port: 8789,
    auth: { username: 'alice', password: 'secret' },
    calendars: [{ slug: 'shopping', displayName: 'Shopping', components: ['VTODO'] }],
    tasks: [
      { uid: 'milk', calendarSlug: 'shopping', etag: 'e1', ics: makeIcs('milk', 'Milk', 'Dairy', 'NEEDS-ACTION', '20260501T100000Z') },
      { uid: 'apples', calendarSlug: 'shopping', etag: 'e2', ics: makeIcs('apples', 'Apples', 'Produce', 'NEEDS-ACTION', '20260501T100000Z') },
    ],
    files: [
      {
        path: 'Notes/tasker-config.json',
        content: JSON.stringify({ categories: ['Produce', 'Dairy'] }),
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
      now: String(tWatchOffline),
    });

    await page.goto(`/?${query.toString()}`);
    await expect(page.getByTestId('watch-status')).toHaveText('2 left');

    // Go offline and check off BOTH Apples and Milk at 10:05
    await page.evaluate(() => window.__fitbitHarness.setOnline(false));
    await page.getByTestId('watch-item-0').click(); // Apples checked at 10:05
    await page.getByTestId('watch-item-1').click(); // Milk checked at 10:05
    await expect(page.getByTestId('watch-status')).toHaveText('Offline (2 pending)');

    await tester.step('offline-both-checked', {
      description: 'Watch stores two unsynced offline toggles at 10:05',
      verifications: [
        {
          spec: 'Both Apples and Milk appear checked with Offline (2 pending)',
          check: async () => {
            await expect(page.getByTestId('watch-status')).toHaveText('Offline (2 pending)');
            await expect(page.getByTestId('watch-item-0')).toHaveAttribute('data-checked', '1');
            await expect(page.getByTestId('watch-item-1')).toHaveAttribute('data-checked', '1');
          },
        },
      ],
    });

    // Server receives a NEWER update to Milk (10:10 > 10:05) keeping it NEEDS-ACTION,
    // and an OLDER update to Apples (10:02 < 10:05) renaming it while NEEDS-ACTION
    server.backend.setTask({
      uid: 'milk',
      calendarSlug: 'shopping',
      etag: 'e1-server-newer',
      ics: makeIcs('milk', 'Organic Milk', 'Dairy', 'NEEDS-ACTION', '20260501T101000Z'),
    });
    server.backend.setTask({
      uid: 'apples',
      calendarSlug: 'shopping',
      etag: 'e2-server-older',
      ics: makeIcs('apples', 'Honeycrisp', 'Produce', 'NEEDS-ACTION', '20260501T100200Z'),
    });

    // Reconnect: Milk reverts to newer server state (unchecked), while Apples's newer watch toggle syncs up!
    await page.evaluate(() => window.__fitbitHarness.setOnline(true));
    await expect(page.getByTestId('watch-status')).toHaveText('1 left');
    await expect(page.getByTestId('watch-item-1')).toContainText('Organic Milk');

    await tester.step('reconciled-server-wins', {
      description: 'Newer server change for Organic Milk wins (unchecked) while newer watch toggle for Honeycrisp syncs to server',
      verifications: [
        {
          spec: 'Honeycrisp stays checked (watch 10:05 > server 10:02) and Organic Milk is unchecked (server 10:10 > watch 10:05)',
          check: async () => {
            await expect(page.getByTestId('watch-item-0')).toContainText('Honeycrisp');
            await expect(page.getByTestId('watch-item-0')).toHaveAttribute('data-checked', '1');
            await expect(page.getByTestId('watch-item-1')).toContainText('Organic Milk');
            await expect(page.getByTestId('watch-item-1')).toHaveAttribute('data-checked', '0');
          },
        },
        {
          spec: 'CalDAV server keeps Organic Milk NEEDS-ACTION and persists Honeycrisp COMPLETED',
          check: async () => {
            const milk = server.backend.getTasks('shopping').find((t) => t.uid === 'milk');
            const apples = server.backend.getTasks('shopping').find((t) => t.uid === 'apples');
            expect(milk?.ics).toContain('STATUS:NEEDS-ACTION');
            expect(apples?.ics).toContain('STATUS:COMPLETED');
          },
        },
      ],
    });

    tester.generateDocs();
  } finally {
    await server.close();
  }
});
