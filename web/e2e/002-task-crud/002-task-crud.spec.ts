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

test('US-002: User manages tasks and customizes category order', async ({ page }, testInfo) => {
  const tester = new TestStepHelper(page, testInfo);
  tester.setMetadata(
    'Task List CRUD & Category Sorting',
    'As a user, I want tasks sorted by category order, and I want to add, check off, edit, reorder categories, and delete tasks.',
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

    await tester.step('category-sorted-list', {
      description: 'Config bootstraps default list and sorts items by category order (Produce before Dairy)',
      verifications: [
        {
          spec: 'Produce heading appears before Dairy heading',
          check: async () => {
            const headings = await page.locator('.category-heading').allTextContents();
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

    // Tap floating + button to add a Bakery item and check off Apples
    await page.getByTestId('add-task-fab').click();
    await expect(page.getByTestId('add-task-modal')).toBeVisible();
    await page.getByLabel('New task').fill('Sourdough bread');
    await page.getByLabel('Category').selectOption('Bakery');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByTestId('add-task-modal')).toBeHidden();
    await expect(page.getByTestId('task-list')).toContainText('Sourdough bread');

    await page.getByLabel('Mark Apples as completed').check();
    await expect(page.locator('[data-task-uid="apples"]')).toHaveClass(/completed/);
    await expect(page.getByTestId('pending-badge')).toBeHidden();
    await page.mouse.move(0, 0);

    await tester.step('added-and-toggled', {
      description: 'Quick-added Bakery item slots between Produce and Dairy, and Apples is checked off',
      verifications: [
        {
          spec: 'Category headings are ordered Produce, Bakery, Dairy',
          check: async () => {
            const headings = await page.locator('.category-heading').allTextContents();
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

    // Unfocused & unhovered row hides Edit / Delete buttons; hovering or focusing reveals them
    await expect(page.locator('[data-edit-uid="milk"]')).toBeHidden();
    await expect(page.locator('[data-delete-uid="milk"]')).toBeHidden();
    await page.locator('[data-task-uid="milk"]').hover();
    await expect(page.locator('[data-edit-uid="milk"]')).toBeVisible();
    await expect(page.locator('[data-delete-uid="milk"]')).toBeVisible();

    // Tap Milk title to focus inline input, then open full Task Editor
    await page.locator('[data-focus-uid="milk"]').click();
    await expect(page.locator('input[data-inline-uid="milk"]')).toBeFocused();
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

    // Open side drawer → Categories and move Dairy to the top
    await page.getByTestId('menu-toggle-btn').click();
    await page.getByTestId('nav-categories').click();
    await expect(page.getByTestId('category-manager')).toBeVisible();
    await page.getByRole('button', { name: 'Move Dairy up' }).click();
    await page.getByRole('button', { name: 'Move Dairy up' }).click();

    await tester.step('category-manager', {
      description: 'User reorders categories in Category Manager (Dairy moved first)',
      verifications: [
        {
          spec: 'Dairy is now first in the category list',
          check: async () => {
            const names = await page.locator('.category-name').allTextContents();
            expect(names).toEqual(['1. Dairy', '2. Produce', '3. Bakery']);
          },
        },
      ],
    });

    // Return to Shopping list via side drawer, hover/focus Apples, and delete with one click
    await page.getByTestId('menu-toggle-btn').click();
    await page.getByTestId('list-option-Shopping').click();
    await page.locator('[data-focus-uid="apples"]').click();
    await page.locator('[data-delete-uid="apples"]').click();
    await expect(page.locator('[data-task-uid="apples"]')).toBeHidden();
    await expect(page.getByTestId('pending-badge')).toBeHidden();
    // Move pointer away so resting list screenshot has no accidental hover state
    await page.mouse.move(0, 0);

    await tester.step('reordered-and-deleted', {
      description: 'Task list reflects updated category order (Dairy first) and removed item is deleted on server',
      verifications: [
        {
          spec: 'Dairy appears before Bakery',
          check: async () => {
            const headings = await page.locator('.category-heading').allTextContents();
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

    // Inline title editing: click task title, type updated name, press Enter
    await page.locator('[data-focus-uid="milk"]').click();
    const inlineInput = page.locator('input[data-inline-uid="milk"]');
    await expect(inlineInput).toBeFocused();
    await inlineInput.fill('Organic 2% milk');
    await inlineInput.press('Enter');
    await expect(page.getByTestId('task-list')).toContainText('Organic 2% milk');
    await expect(page.getByTestId('pending-badge')).toBeHidden();

    // Clear done: check off Milk and clear all completed tasks in one click
    await page.getByLabel('Mark Organic 2% milk as completed').check();
    await expect(page.getByTestId('clear-completed-btn')).toContainText('Clear done (1)');
    await page.getByTestId('clear-completed-btn').click();
    await expect(page.locator('[data-task-uid="milk"]')).toBeHidden();
    await expect(page.getByTestId('pending-badge')).toBeHidden();
    expect(server.backend.getTasks('shopping')).toHaveLength(1);

    tester.generateDocs();
  } finally {
    await server.close();
  }
});
