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

test('US-002: User manages grocery items and customizes store aisle order', async ({ page }, testInfo) => {
  const tester = new TestStepHelper(page, testInfo);
  tester.setMetadata(
    'Grocery List CRUD & Aisle Sorting',
    'As a shopper, I want items sorted by store aisle, and I want to add, check off, edit, reorder aisles, and delete items.',
  );

  const server = await startMockCalDavServer({
    auth: { username: 'alice', password: 'secret' },
    tasks: [
      { uid: 'milk', calendarSlug: 'shopping', etag: 'e1', ics: makeIcs('milk', 'Milk', 'Dairy') },
      { uid: 'apples', calendarSlug: 'shopping', etag: 'e2', ics: makeIcs('apples', 'Apples', 'Produce') },
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
    await expect(page.getByTestId('status')).toContainText('Loaded 2 tasks');

    await tester.step('aisle-sorted-list', {
      description: 'Config bootstraps default list and sorts items by aisle walk order (Produce before Dairy)',
      verifications: [
        {
          spec: 'Produce heading appears before Dairy heading',
          check: async () => {
            const headings = await page.locator('.aisle-heading').allTextContents();
            expect(headings).toEqual(['Produce', 'Dairy']);
          },
        },
        {
          spec: 'Both Apples and Milk are rendered',
          check: async () => {
            await expect(page.getByTestId('task-list')).toContainText('Apples');
            await expect(page.getByTestId('task-list')).toContainText('Milk');
          },
        },
      ],
    });

    // Quick-add a Bakery item and check off Apples
    await page.getByLabel('New grocery item').fill('Sourdough bread');
    await page.getByLabel('Aisle').selectOption('Bakery');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByTestId('task-list')).toContainText('Sourdough bread');

    await page.getByLabel('Mark Apples as completed').check();
    await expect(page.locator('[data-task-uid="apples"]')).toHaveClass(/completed/);

    await tester.step('added-and-toggled', {
      description: 'Quick-added Bakery item slots between Produce and Dairy, and Apples is checked off',
      verifications: [
        {
          spec: 'Aisle headings are ordered Produce, Bakery, Dairy',
          check: async () => {
            const headings = await page.locator('.aisle-heading').allTextContents();
            expect(headings).toEqual(['Produce', 'Bakery', 'Dairy']);
          },
        },
        {
          spec: 'Server persisted 3 tasks with Apples marked COMPLETED',
          check: async () => {
            const remote = server.backend.getTasks('shopping');
            expect(remote).toHaveLength(3);
            const apples = remote.find((t) => t.uid === 'apples');
            expect(apples?.ics).toContain('STATUS:COMPLETED');
          },
        },
      ],
    });

    // Edit Milk via Task Editor
    await page.locator('[data-edit-uid="milk"]').click();
    await expect(page.getByTestId('task-editor-modal')).toBeVisible();
    await page.locator('#task-editor-form input[name="summary"]').fill('Organic whole milk');
    await page.locator('#task-editor-form textarea[name="description"]').fill('2% fat preferred');

    await tester.step('task-editor', {
      description: 'Task editor modal allows updating summary, categories, notes, and priority',
      verifications: [
        {
          spec: 'Task editor modal is visible with updated fields',
          check: async () => {
            await expect(page.getByTestId('task-editor-modal')).toBeVisible();
            await expect(page.locator('#task-editor-form input[name="summary"]')).toHaveValue('Organic whole milk');
          },
        },
      ],
    });

    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByTestId('task-editor-modal')).toBeHidden();
    await expect(page.getByTestId('task-list')).toContainText('Organic whole milk');

    // Reorder aisles in Aisle Manager: move Dairy to the top
    await page.getByRole('button', { name: 'Aisles' }).click();
    await expect(page.getByTestId('aisle-manager')).toBeVisible();
    await page.getByRole('button', { name: 'Move Dairy up' }).click();
    await page.getByRole('button', { name: 'Move Dairy up' }).click();

    await tester.step('aisle-manager', {
      description: 'User reorders aisles in Aisle Manager (Dairy moved first)',
      verifications: [
        {
          spec: 'Dairy is now first in the aisle list',
          check: async () => {
            const names = await page.locator('.aisle-name').allTextContents();
            expect(names).toEqual(['1. Dairy', '2. Produce', '3. Bakery']);
          },
        },
      ],
    });

    // Return to Grocery List and verify new walk order + delete Apples
    await page.getByRole('button', { name: 'Grocery List' }).click();
    await page.locator('[data-edit-uid="apples"]').click();
    await page.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Confirm Delete' }).click();
    await expect(page.locator('[data-task-uid="apples"]')).toBeHidden();

    await tester.step('reordered-and-deleted', {
      description: 'Grocery list reflects updated aisle order (Dairy first) and removed item is deleted on server',
      verifications: [
        {
          spec: 'Dairy appears before Bakery',
          check: async () => {
            const headings = await page.locator('.aisle-heading').allTextContents();
            expect(headings).toEqual(['Dairy', 'Bakery']);
          },
        },
        {
          spec: 'Server has 2 remaining tasks without Apples',
          check: async () => {
            const remote = server.backend.getTasks('shopping');
            expect(remote).toHaveLength(2);
            expect(remote.some((t) => t.uid === 'apples')).toBe(false);
          },
        },
      ],
    });

    tester.generateDocs();
  } finally {
    await server.close();
  }
});
