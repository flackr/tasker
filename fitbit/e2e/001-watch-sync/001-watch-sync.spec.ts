import { expect, test } from '@playwright/test';
import { startMockCalDavServer } from '@tasker/mock-caldav';
import { TestStepHelper } from '../helpers/test-step-helper';

function makeIcs(
  uid: string,
  summary: string,
  categories: string,
  options?: { status?: string; lastModified?: string; extra?: string },
): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTODO',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    `CATEGORIES:${categories}`,
    `STATUS:${options?.status ?? 'NEEDS-ACTION'}`,
    `LAST-MODIFIED:${options?.lastModified ?? '20260501T100000Z'}`,
  ];
  if (options?.extra) lines.push(options.extra);
  lines.push('END:VTODO', 'END:VCALENDAR');
  return lines.join('\r\n');
}

test('FIT-001: Versa 2 multi-list selection, category-sorted tasks, offline fs restart, and list switching', async ({ page }, testInfo) => {
  const tester = new TestStepHelper(page, testInfo);
  tester.setMetadata(
    'Fitbit Versa 2 Multi-List & Offline Sync',
    'As a Versa 2 user, I want to pick between my CalDAV task lists, check off items sorted by category online or offline, survive restarts from local watch storage, and go back to switch lists.',
  );

  const server = await startMockCalDavServer({
    port: 8788,
    auth: { username: 'alice', password: 'secret' },
    calendars: [
      { slug: 'personal', displayName: 'Personal', components: ['VEVENT'] },
      { slug: 'shopping', displayName: 'Shopping', components: ['VTODO'] },
      { slug: 'hardware', displayName: 'Hardware', components: ['VTODO'] },
    ],
    tasks: [
      { uid: 'milk', calendarSlug: 'shopping', etag: 'e1', ics: makeIcs('milk', 'Milk', 'Dairy', { extra: 'X-PRESERVE:yes' }) },
      { uid: 'apples', calendarSlug: 'shopping', etag: 'e2', ics: makeIcs('apples', 'Apples', 'Produce', { extra: 'X-PRESERVE:yes' }) },
      { uid: 'bread', calendarSlug: 'shopping', etag: 'e3', ics: makeIcs('bread', 'Sourdough', 'Bakery') },
      { uid: 'screws', calendarSlug: 'hardware', etag: 'h1', ics: makeIcs('screws', 'Wood Screws', 'Fasteners') },
    ],
    files: [
      {
        path: 'Notes/tasker-config.json',
        content: JSON.stringify({
          categories: ['Produce', 'Bakery', 'Dairy'],
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
      now: String(Date.parse('2026-05-01T10:05:00.000Z')),
    });

    await page.goto(`/?${query.toString()}`);
    await expect(page.getByTestId('watch-status')).toHaveText('Lists (2)');

    await tester.step('list-picker', {
      description: 'Versa 2 shows available VTODO task lists (filtering out VEVENT-only calendars)',
      verifications: [
        {
          spec: 'Status shows 2 available lists',
          check: async () => await expect(page.getByTestId('watch-status')).toHaveText('Lists (2)'),
        },
        {
          spec: 'Shopping and Hardware lists are shown',
          check: async () => {
            await expect(page.getByTestId('watch-list-item-0')).toContainText('Shopping');
            await expect(page.getByTestId('watch-list-item-1')).toContainText('Hardware');
          },
        },
      ],
    });

    // Tap Shopping list
    await page.getByTestId('watch-list-item-0').click();
    await expect(page.getByTestId('watch-status')).toHaveText('3 left');

    await tester.step('initial-sync', {
      description: 'Selecting Shopping slides to the top-level Tasks page with short category headers (Produce → Bakery → Dairy), large-font task items, slim 28px status bar, and scrolled past the pull-down Sync tile',
      verifications: [
        {
          spec: 'Slim status bar shows 3 left with Lists › hint and list starts scrolled past rows 0-1 onto row 2',
          check: async () => {
            await expect(page.getByTestId('watch-status')).toHaveText('3 left');
            await expect(page.getByTestId('watch-page-hint')).toHaveText('Lists ›');
            const scrollVal = await page.evaluate(() => window.__fitbitHarness.getTasksScrollValue());
            expect(scrollVal).toBe(2);
          },
        },
        {
          spec: 'Pressing Versa 2 hardware Back from top-level task list does not hijack exit or forget the selected list',
          check: async () => {
            const intercepted = await page.evaluate(() => window.__fitbitHarness.pressHardwareBack());
            expect(intercepted).toBe(false);
            await expect(page.getByTestId('watch-tasks-view')).toBeVisible();
          },
        },
        {
          spec: 'Category headers and large-font tasks appear in order: Produce/Apples, Bakery/Sourdough, Dairy/Milk',
          check: async () => {
            await expect(page.getByTestId('watch-category-0')).toHaveText('Produce');
            await expect(page.getByTestId('watch-item-0')).toContainText('Apples');
            await expect(page.getByTestId('watch-category-1')).toHaveText('Bakery');
            await expect(page.getByTestId('watch-item-1')).toContainText('Sourdough');
            await expect(page.getByTestId('watch-category-2')).toHaveText('Dairy');
            await expect(page.getByTestId('watch-item-2')).toContainText('Milk');
          },
        },
      ],
    });

    // Tap Apples → instant local toggle (no BLE traffic until next sync), then pull down to reveal Sync & Autohide
    await page.getByTestId('watch-item-0').click();
    await expect(page.getByTestId('watch-item-0')).toHaveAttribute('data-checked', '1');
    await expect(page.getByTestId('watch-status')).toHaveText('1 unsynced');
    expect(server.backend.getTasks('shopping').find((t) => t.uid === 'apples')?.ics).toContain('STATUS:NEEDS-ACTION');

    await page.evaluate(() => window.__fitbitHarness.pullToActions());
    await expect(page.getByTestId('watch-sync-btn')).toBeVisible();
    await expect(page.getByTestId('watch-autohide-btn')).toHaveText('Autohide');
    await page.getByTestId('watch-sync-btn').click();
    await expect(page.getByTestId('watch-status')).toHaveText('2 left');

    await tester.step('toggled-online', {
      description: 'Tapping Apples toggles instantly on the watch; pulling down and tapping Sync persists COMPLETED losslessly to CalDAV',
      verifications: [
        {
          spec: 'Apples tile is checked, status updates to 2 left, and list scrolls back past actions tile (value=2)',
          check: async () => {
            await expect(page.getByTestId('watch-item-0')).toHaveAttribute('data-checked', '1');
            await expect(page.getByTestId('watch-status')).toHaveText('2 left');
            const scrollVal = await page.evaluate(() => window.__fitbitHarness.getTasksScrollValue());
            expect(scrollVal).toBe(2);
          },
        },
        {
          spec: 'Mock CalDAV server persisted COMPLETED and preserved X-PRESERVE',
          check: async () => {
            const apples = server.backend.getTasks('shopping').find((t) => t.uid === 'apples');
            expect(apples?.ics).toContain('STATUS:COMPLETED');
            expect(apples?.ics).toContain('X-PRESERVE:yes');
          },
        },
      ],
    });

    // Pull down and toggle Autohide → checked Apples & empty Produce header disappear; toggle Show All to restore
    await page.evaluate(() => window.__fitbitHarness.pullToActions());
    await page.getByTestId('watch-autohide-btn').click();
    await expect(page.getByTestId('watch-autohide-btn')).toHaveText('Show All');
    await expect(page.getByTestId('watch-category-0')).toHaveText('Bakery');
    await expect(page.getByTestId('watch-item-0')).toContainText('Sourdough');
    await expect(page.getByTestId('watch-tasks-view')).not.toContainText('Apples');
    await page.evaluate(() => window.__fitbitHarness.pullToActions());
    await page.getByTestId('watch-autohide-btn').click();
    await expect(page.getByTestId('watch-autohide-btn')).toHaveText('Autohide');
    await expect(page.getByTestId('watch-item-0')).toContainText('Apples');

    // Disconnect Bluetooth, toggle Milk offline, then reload watch app while still offline
    await page.evaluate(() => window.__fitbitHarness.setOnline(false));
    await page.getByTestId('watch-item-2').click();
    await expect(page.getByTestId('watch-status')).toHaveText('Offline (1 pending)');

    await page.goto(`/?offline=1&now=${Date.parse('2026-05-01T10:05:00.000Z')}`);
    await expect(page.getByTestId('watch-status')).toHaveText('Offline (1 pending)');

    await tester.step('offline-restart-cache', {
      description: 'Watch restarts immediately into the stored Shopping list from Fitbit fs cache with pending toggle intact',
      verifications: [
        {
          spec: 'Status shows Offline (1 pending) immediately after restart',
          check: async () => await expect(page.getByTestId('watch-status')).toHaveText('Offline (1 pending)'),
        },
        {
          spec: 'Milk remains checked from local per-list fs storage',
          check: async () => await expect(page.getByTestId('watch-item-2')).toHaveAttribute('data-checked', '1'),
        },
      ],
    });

    // Reconnect Bluetooth → pending toggle reconciles & syncs to CalDAV
    await page.evaluate(() => window.__fitbitHarness.setOnline(true));
    await expect(page.getByTestId('watch-status')).toHaveText('1 left');

    await tester.step('reconnected-synced', {
      description: 'Reconnecting syncs the newer offline watch toggle to CalDAV and clears pending state',
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

    // Swipe from right via #panoramaview → opens Lists page
    await page.evaluate(() => window.__fitbitHarness.swipeToLists());
    await expect(page.getByTestId('watch-lists-view')).toBeVisible();
    await expect(page.getByTestId('watch-page-hint')).toHaveText('‹ Tasks');
    await expect(page.getByTestId('watch-status')).toHaveText('Lists (2)');
    await expect(page.getByTestId('watch-list-item-0')).toContainText('1 left');

    // Verify hardware Back on Lists page slides back to Shopping without exiting
    const closedSubView = await page.evaluate(() => window.__fitbitHarness.pressHardwareBack());
    expect(closedSubView).toBe(true);
    await expect(page.getByTestId('watch-tasks-view')).toBeVisible();
    await expect(page.getByTestId('watch-page-hint')).toHaveText('Lists ›');

    // Swipe from right again and switch to Hardware list
    await page.evaluate(() => window.__fitbitHarness.swipeToLists());
    await expect(page.getByTestId('watch-lists-view')).toBeVisible();
    await expect(page.getByTestId('watch-status')).toHaveText('Lists (2)');
    await page.getByTestId('watch-list-item-1').click();
    await expect(page.getByTestId('watch-item-0')).toContainText('Wood Screws');

    await tester.step('switched-list', {
      description: 'User swipes from the right to the Lists page and switches to the Hardware list',
      verifications: [
        {
          spec: 'Hardware list category Fasteners and task Wood Screws are displayed',
          check: async () => {
            await expect(page.getByTestId('watch-status')).toHaveText('1 left');
            await expect(page.getByTestId('watch-category-0')).toHaveText('Fasteners');
            await expect(page.getByTestId('watch-item-0')).toContainText('Wood Screws');
          },
        },
      ],
    });

    tester.generateDocs();
  } finally {
    await server.close();
  }
});
