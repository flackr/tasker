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

test('US-006: User switches task lists from the main title and manages per-list categories', async ({ page }, testInfo) => {
  const tester = new TestStepHelper(page, testInfo);
  tester.setMetadata(
    'Quick List Switching & Per-List Categories',
    'As a user with multiple task lists, I want the active list name as the main title so clicking it lets me switch lists immediately, and I want each list to maintain its own categories.',
  );

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

    await expect(page.getByTestId('list-switcher-btn')).toContainText('Shopping');
    await expect(page.locator('.category-heading')).toHaveText(['Produce', 'Dairy']);

    // Click main list title to open the list switcher menu
    await page.getByTestId('list-switcher-btn').click();
    await expect(page.getByTestId('list-switcher-menu')).toBeVisible();

    await tester.step('list-switcher-open', {
      description: 'Clicking the active list title in the header opens the quick list switcher menu',
      verifications: [
        {
          spec: 'Main title shows Shopping and switcher menu lists Shopping and Hardware',
          check: async () => {
            await expect(page.getByTestId('list-switcher-btn')).toContainText('Shopping');
            await expect(page.getByTestId('list-option-Shopping')).toHaveAttribute('aria-checked', 'true');
            await expect(page.getByTestId('list-option-Hardware')).toBeVisible();
          },
        },
      ],
    });

    // Switch to Hardware list
    await page.getByTestId('list-option-Hardware').click();
    await expect(page.getByTestId('list-switcher-btn')).toContainText('Hardware');
    await expect(page.locator('.category-heading')).toHaveText(['Electrical', 'Fasteners']);

    await tester.step('switched-to-hardware', {
      description: 'Selecting Hardware updates the main title and loads Hardware tasks sorted by its own categories',
      verifications: [
        {
          spec: 'Main title is Hardware and tasks are grouped Electrical before Fasteners',
          check: async () => {
            await expect(page.getByTestId('list-switcher-btn')).toContainText('Hardware');
            await expect(page.locator('.category-heading')).toHaveText(['Electrical', 'Fasteners']);
            await expect(page.getByTestId('task-list')).toContainText('Romex Wire');
            await expect(page.getByTestId('task-list')).toContainText('Wood Screws');
          },
        },
      ],
    });

    // Open Categories tab for Hardware and add a Hardware-only category ("Lumber")
    await page.getByRole('button', { name: 'Categories' }).click();
    await expect(page.getByTestId('category-manager')).toContainText('Hardware Categories');
    await page.getByLabel('New category name').fill('Lumber');
    await page.getByRole('button', { name: 'Add category' }).click();
    await expect(page.locator('.category-name')).toHaveText([
      '1. Electrical',
      '2. Fasteners',
      '3. Lumber',
    ]);

    await tester.step('per-list-categories', {
      description: 'Categories tab edits categories specifically for Hardware without modifying Shopping',
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

    // Switching back to Shopping while on Categories tab immediately shows Shopping's own categories
    await page.getByTestId('list-switcher-btn').click();
    await page.getByTestId('list-option-Shopping').click();
    await expect(page.getByTestId('category-manager')).toContainText('Shopping Categories');
    await expect(page.locator('.category-name')).toHaveText(['1. Produce', '2. Dairy']);

    tester.generateDocs();
  } finally {
    await server.close();
  }
});
