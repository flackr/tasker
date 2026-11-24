import { expect, test } from '@playwright/test';
import { startMockCalDavServer } from '@tasker/mock-caldav';
import { TestStepHelper } from '../helpers/test-step-helper';

function makeIcs(uid: string, summary: string, categories: string, status = 'NEEDS-ACTION'): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTODO',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    `CATEGORIES:${categories}`,
    `STATUS:${status}`,
    'LAST-MODIFIED:20260501T100000Z',
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n');
}

test.use({ colorScheme: 'dark' });

test('US-007: Automatic dark mode applies high-contrast theme via prefers-color-scheme: dark', async ({ page }, testInfo) => {
  const tester = new TestStepHelper(page, testInfo);
  tester.setMetadata(
    'Automatic Dark Mode',
    'As a user with system dark mode enabled, I want the PWA to automatically adopt a dark color scheme with high-contrast text and action icons.',
  );

  const server = await startMockCalDavServer({
    port: 8793,
    auth: { username: 'alice', password: 'secret' },
    calendars: [
      { slug: 'shopping', displayName: 'Shopping', components: ['VTODO'] },
      { slug: 'hardware', displayName: 'Hardware', components: ['VTODO'] },
    ],
    tasks: [
      { uid: 'apples', calendarSlug: 'shopping', etag: 's1', ics: makeIcs('apples', 'Apples', 'Produce', 'COMPLETED') },
      { uid: 'bread', calendarSlug: 'shopping', etag: 's2', ics: makeIcs('bread', 'Sourdough bread', 'Bakery') },
      { uid: 'milk', calendarSlug: 'shopping', etag: 's3', ics: makeIcs('milk', 'Milk', 'Dairy') },
    ],
    files: [
      {
        path: 'Notes/tasker-config.json',
        content: JSON.stringify({
          defaultCalendarHref: '/remote.php/dav/calendars/alice/shopping/',
          categories: ['Produce', 'Bakery', 'Dairy'],
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

    await expect(page.getByTestId('list-panel')).toBeVisible();
    await expect(page.getByTestId('header-status')).toHaveText('Synced');

    // Focus Milk to display the inline editor alongside high-contrast pencil & cross icons
    await page.locator('[data-focus-uid="milk"]').click();
    await expect(page.locator('[data-edit-uid="milk"]')).toBeVisible();
    await expect(page.locator('[data-delete-uid="milk"]')).toBeVisible();

    await tester.step('dark-task-list-focused', {
      description: 'Dark mode renders deep slate surfaces, bright typography, and high-contrast pencil/cross icons on the focused task row',
      verifications: [
        {
          spec: 'Root element advertises color-scheme: dark light and dark background',
          check: async () => {
            const styles = await page.evaluate(() => {
              const root = getComputedStyle(document.documentElement);
              return { colorScheme: root.colorScheme, backgroundColor: root.backgroundColor };
            });
            expect(styles.colorScheme).toBe('dark light');
            expect(styles.backgroundColor).toBe('rgb(11, 17, 32)');
          },
        },
        {
          spec: 'Pencil (Edit) and Cross (Delete) icons use bright high-contrast colors in dark mode',
          check: async () => {
            const iconColors = await page.evaluate(() => ({
              edit: getComputedStyle(document.querySelector('[data-edit-uid="milk"]')!).color,
              del: getComputedStyle(document.querySelector('[data-delete-uid="milk"]')!).color,
            }));
            expect(iconColors.edit).toBe('rgb(203, 213, 225)');
            expect(iconColors.del).toBe('rgb(248, 113, 113)');
          },
        },
      ],
    });

    // Open side drawer in dark mode
    await page.getByTestId('menu-toggle-btn').click();
    await expect(page.getByTestId('nav-drawer')).toBeVisible();

    await tester.step('dark-side-drawer', {
      description: 'Side drawer adopts dark surfaces with high-contrast active state and checkmark icon',
      verifications: [
        {
          spec: 'Side drawer is visible with Shopping marked active',
          check: async () => {
            await expect(page.getByTestId('list-option-Shopping')).toHaveAttribute('aria-current', 'true');
            await expect(page.getByTestId('nav-categories')).toBeVisible();
            await expect(page.getByTestId('nav-settings')).toBeVisible();
          },
        },
      ],
    });

    tester.generateDocs();
  } finally {
    await server.close();
  }
});
