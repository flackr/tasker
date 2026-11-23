import { expect, test } from '@playwright/test';
import { startMockCalDavServer } from '@tasker/mock-caldav';
import { TestStepHelper } from '../helpers/test-step-helper';

function makeIcs(uid: string, summary: string, categories: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTODO',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    `CATEGORIES:${categories}`,
    'STATUS:NEEDS-ACTION',
    'LAST-MODIFIED:20260501T100000Z',
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n');
}

test('US-006: Compact mobile header, side drawer list switching, + add-task dialog, and per-list categories', async ({ page }, testInfo) => {
  const tester = new TestStepHelper(page, testInfo);
  tester.setMetadata(
    'Compact Mobile Layout, Side Drawer & Per-List Categories',
    'As a mobile user, I want a compact single-line header showing the active list and sync status, a side drawer for switching lists and opening Categories/Settings, per-list categories, and a + button to open the new-task dialog.',
  );

  // Use a realistic mobile viewport to verify single-line header & compact mobile ergonomics
  await page.setViewportSize({ width: 390, height: 844 });

  const shoppingHref = '/remote.php/dav/calendars/alice/shopping/';
  const hardwareHref = '/remote.php/dav/calendars/alice/hardware/';

  const server = await startMockCalDavServer({
    port: 8792,
    auth: { username: 'alice', password: 'secret' },
    calendars: [
      { slug: 'shopping', displayName: 'Shopping', components: ['VTODO'] },
      { slug: 'hardware', displayName: 'Hardware', components: ['VTODO'] },
    ],
    tasks: [
      { uid: 'milk', calendarSlug: 'shopping', etag: 's1', ics: makeIcs('milk', 'Milk', 'Dairy') },
      { uid: 'apples', calendarSlug: 'shopping', etag: 's2', ics: makeIcs('apples', 'Apples', 'Produce') },
      { uid: 'screws', calendarSlug: 'hardware', etag: 'h1', ics: makeIcs('screws', 'Wood Screws', 'Fasteners') },
      { uid: 'wire', calendarSlug: 'hardware', etag: 'h2', ics: makeIcs('wire', 'Romex Wire', 'Electrical') },
    ],
    files: [
      {
        path: 'Notes/tasker-config.json',
        content: JSON.stringify({
          defaultCalendarHref: shoppingHref,
          categoriesByCalendar: {
            [shoppingHref]: ['Produce', 'Dairy'],
            [hardwareHref]: ['Electrical', 'Fasteners'],
          },
        }),
        contentType: 'application/json',
      },
    ],
    allowedOrigin: 'http://127.0.0.1:4173',
  });

  try {
    await page.goto('/');
    await page.getByLabel('Nextcloud URL').fill(server.url);
    await page.getByLabel('Username').fill('alice');
    await page.getByLabel('App password').fill('secret');
    await page.getByLabel('Config JSON path').fill('Notes/tasker-config.json');
    await page.getByRole('button', { name: 'Connect' }).click();

    await expect(page.getByTestId('header-title')).toContainText('Shopping');
    await expect(page.getByTestId('header-status')).toHaveText('Synced');
    await expect(page.locator('.category-heading')).toHaveText(['Produce', 'Dairy']);

    // Verify single-line compact header on mobile (52px tall)
    const headerBox = await page.locator('.app-header').boundingBox();
    expect(headerBox?.height).toBeLessThanOrEqual(54);

    // Open side drawer from menu button / title
    await page.getByTestId('menu-toggle-btn').click();
    await expect(page.getByTestId('nav-drawer')).toBeVisible();

    await tester.step('side-drawer-open', {
      description: 'Side drawer lists all task lists alongside Categories and Settings while keeping the header to a single line',
      verifications: [
        {
          spec: 'Side drawer shows Shopping (active), Hardware, Categories, and Settings',
          check: async () => {
            await expect(page.getByTestId('list-option-Shopping')).toHaveAttribute('aria-current', 'true');
            await expect(page.getByTestId('list-option-Hardware')).toBeVisible();
            await expect(page.getByTestId('nav-categories')).toBeVisible();
            await expect(page.getByTestId('nav-settings')).toBeVisible();
          },
        },
      ],
    });

    // Switch to Hardware list from drawer
    await page.getByTestId('list-option-Hardware').click();
    await expect(page.getByTestId('nav-drawer')).toBeHidden();
    await expect(page.getByTestId('header-title')).toContainText('Hardware');
    await expect(page.getByTestId('header-status')).toHaveText('Synced');
    await expect(page.locator('.category-heading')).toHaveText(['Electrical', 'Fasteners']);

    await tester.step('switched-to-hardware', {
      description: 'Mobile view shows a single-line Hardware header, Hardware tasks sorted by its own categories, and a floating + button',
      verifications: [
        {
          spec: 'Header shows Hardware and Synced on a single line',
          check: async () => {
            await expect(page.getByTestId('header-title')).toContainText('Hardware');
            await expect(page.getByTestId('header-status')).toHaveText('Synced');
          },
        },
        {
          spec: 'Hardware tasks are grouped Electrical before Fasteners and + button is visible',
          check: async () => {
            await expect(page.locator('.category-heading')).toHaveText(['Electrical', 'Fasteners']);
            await expect(page.getByTestId('add-task-fab')).toBeVisible();
          },
        },
      ],
    });

    // Tap floating + button to open New Task modal
    await page.getByTestId('add-task-fab').click();
    await expect(page.getByTestId('add-task-modal')).toBeVisible();

    await tester.step('add-task-modal', {
      description: 'Tapping the + button opens the New Task modal populated with Hardware categories',
      verifications: [
        {
          spec: 'New Task dialog is visible with Electrical and Fasteners options',
          check: async () => {
            await expect(page.getByTestId('add-task-modal')).toBeVisible();
            await expect(page.getByLabel('Category')).toContainText('Electrical');
            await expect(page.getByLabel('Category')).toContainText('Fasteners');
          },
        },
      ],
    });

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('add-task-modal')).toBeHidden();

    // Open Categories from side drawer for Hardware and add "Lumber"
    await page.getByTestId('menu-toggle-btn').click();
    await page.getByTestId('nav-categories').click();
    await expect(page.getByTestId('category-manager')).toContainText('Hardware Categories');
    await page.getByLabel('New category name').fill('Lumber');
    await page.getByRole('button', { name: 'Add category' }).click();
    await expect(page.locator('.category-name')).toHaveText([
      '1. Electrical',
      '2. Fasteners',
      '3. Lumber',
    ]);

    await tester.step('per-list-categories', {
      description: 'Categories view edits categories specifically for Hardware without modifying Shopping',
      verifications: [
        {
          spec: 'Hardware Categories shows Electrical, Fasteners, Lumber',
          check: async () => {
            await expect(page.getByTestId('category-manager')).toContainText('Hardware Categories');
            await expect(page.locator('.category-name')).toHaveText([
              '1. Electrical',
              '2. Fasteners',
              '3. Lumber',
            ]);
          },
        },
        {
          spec: 'Remote tasker-config.json preserves Shopping categories independently from Hardware',
          check: async () => {
            await expect
              .poll(() => {
                const raw = server.backend.getFile('Notes/tasker-config.json');
                return raw ? JSON.parse(raw).categoriesByCalendar?.[hardwareHref] : null;
              })
              .toEqual(['Electrical', 'Fasteners', 'Lumber']);
            const cfg = JSON.parse(server.backend.getFile('Notes/tasker-config.json')!);
            expect(cfg.categoriesByCalendar[shoppingHref]).toEqual(['Produce', 'Dairy']);
          },
        },
      ],
    });

    // Simulate another device reordering Hardware categories on Nextcloud → tapping Sync pulls new order!
    const remoteCfg = JSON.parse(server.backend.getFile('Notes/tasker-config.json')!);
    remoteCfg.categoriesByCalendar[hardwareHref] = ['Fasteners', 'Electrical', 'Lumber'];
    server.backend.setFile('Notes/tasker-config.json', JSON.stringify(remoteCfg), 'application/json');

    await page.getByTestId('menu-toggle-btn').click();
    await page.getByTestId('list-option-Hardware').click();
    await page.getByTestId('sync-now').click();
    await expect(page.locator('.category-heading')).toHaveText(['Fasteners', 'Electrical']);

    tester.generateDocs();
  } finally {
    await server.close();
  }
});
