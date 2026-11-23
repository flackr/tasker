import { expect, test } from '@playwright/test';
import { startMockCalDavServer } from '@tasker/mock-caldav';
import { TestStepHelper } from '../helpers/test-step-helper';

function makeUncategorizedIcs(uid: string, summary: string): string {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTODO',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    'STATUS:NEEDS-ACTION',
    'LAST-MODIFIED:20260501T100000Z',
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\r\n');
}

test('US-004: Auto-categorize uncategorized tasks using the browser Prompt API', async ({ page }, testInfo) => {
  const tester = new TestStepHelper(page, testInfo);
  tester.setMetadata(
    'On-Device AI Auto-Categorize (Prompt API)',
    'As a user with a browser supporting the Web Prompt API (LanguageModel), I want to enable Auto-Categorize so uncategorized tasks are stepped through one by one and assigned to matching categories automatically.',
  );

  // Inject a deterministic browser Prompt API (LanguageModel) implementation
  await page.addInitScript(() => {
    const promptLog: string[] = [];
    (window as unknown as { __promptCalls: string[] }).__promptCalls = promptLog;
    (window as unknown as { LanguageModel: unknown }).LanguageModel = {
      async availability() {
        return 'available';
      },
      async create() {
        return {
          async prompt(input: string) {
            promptLog.push(input);
            if (/Bananas/i.test(input)) return JSON.stringify({ category: 'Produce' });
            if (/Sourdough/i.test(input)) return JSON.stringify({ category: 'Bakery' });
            if (/Milk|Cheddar/i.test(input)) return JSON.stringify({ category: 'Dairy' });
            return JSON.stringify({ category: null });
          },
          destroy() {},
        };
      },
    };
  });

  const server = await startMockCalDavServer({
    port: 8790,
    auth: { username: 'alice', password: 'secret' },
    tasks: [
      { uid: 'bananas', calendarSlug: 'shopping', etag: 'e1', ics: makeUncategorizedIcs('bananas', 'Bananas') },
      { uid: 'milk', calendarSlug: 'shopping', etag: 'e2', ics: makeUncategorizedIcs('milk', 'Whole Milk') },
      { uid: 'bread', calendarSlug: 'shopping', etag: 'e3', ics: makeUncategorizedIcs('bread', 'Sourdough Loaf') },
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
    await expect(page.getByTestId('run-auto-categorize')).toContainText('Auto-categorize (3)');

    // Open Settings via side drawer and verify Prompt API availability + enable Auto-Categorize
    await page.getByTestId('menu-toggle-btn').click();
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('ai-availability-badge')).toHaveText('Local AI ready');
    await page.getByTestId('auto-categorize-toggle').check();

    await tester.step('settings-enabled', {
      description: 'Settings detects the browser Prompt API and lets the user enable Auto-Categorize',
      verifications: [
        {
          spec: 'Prompt API badge shows Local AI ready',
          check: async () => await expect(page.getByTestId('ai-availability-badge')).toHaveText('Local AI ready'),
        },
        {
          spec: 'Auto-categorize setting is checked',
          check: async () => await expect(page.getByTestId('auto-categorize-toggle')).toBeChecked(),
        },
      ],
    });

    // Switch back to Shopping list via side drawer → automatically steps through the 3 uncategorized items
    await page.getByTestId('menu-toggle-btn').click();
    await page.getByTestId('list-option-Shopping').click();

    await expect(page.locator('.category-heading')).toHaveText(['Produce', 'Bakery', 'Dairy']);
    await expect(page.getByTestId('ai-progress-banner')).toBeHidden();
    await expect(page.getByTestId('run-auto-categorize')).toBeHidden();
    await expect(page.getByTestId('pending-badge')).toBeHidden();

    await tester.step('auto-categorized-list', {
      description: 'On-device AI steps through all 3 uncategorized items and assigns them into Produce, Bakery, and Dairy',
      verifications: [
        {
          spec: 'All 3 items are grouped into Produce, Bakery, and Dairy in category order',
          check: async () => {
            const headings = await page.locator('.category-heading').allTextContents();
            expect(headings).toEqual(['Produce', 'Bakery', 'Dairy']);
          },
        },
        {
          spec: 'Prompt API was called individually for each uncategorized task',
          check: async () => {
            const calls = await page.evaluate(
              () => (window as unknown as { __promptCalls: string[] }).__promptCalls.length,
            );
            expect(calls).toBe(3);
          },
        },
        {
          spec: 'CalDAV server persisted the assigned CATEGORIES for all 3 tasks',
          check: async () => {
            const remote = server.backend.getTasks('shopping');
            expect(remote.find((t) => t.uid === 'bananas')?.ics).toContain('CATEGORIES:Produce');
            expect(remote.find((t) => t.uid === 'bread')?.ics).toContain('CATEGORIES:Bakery');
            expect(remote.find((t) => t.uid === 'milk')?.ics).toContain('CATEGORIES:Dairy');
          },
        },
      ],
    });

    // Tap + button to add a new uncategorized item while Auto-Categorize is on → automatically lands in Dairy
    await page.getByTestId('add-task-fab').click();
    await expect(page.getByTestId('add-task-modal')).toBeVisible();
    await page.getByLabel('New task').fill('Cheddar Cheese');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await expect(page.getByTestId('add-task-modal')).toBeHidden();
    await expect(page.locator('[data-category="Dairy"]')).toContainText('Cheddar Cheese');
    await expect(page.getByTestId('ai-progress-banner')).toBeHidden();
    await expect(page.getByTestId('pending-badge')).toBeHidden();

    await tester.step('quick-add-auto-categorized', {
      description: 'Newly added uncategorized task is automatically categorized into Dairy by the local AI',
      verifications: [
        {
          spec: 'Cheddar Cheese appears inside the Dairy category group',
          check: async () => await expect(page.locator('[data-category="Dairy"]')).toContainText('Cheddar Cheese'),
        },
        {
          spec: 'Server persisted Cheddar Cheese with CATEGORIES:Dairy',
          check: async () => {
            const cheddar = server.backend.getTasks('shopping').find((t) => t.ics.includes('Cheddar Cheese'));
            expect(cheddar?.ics).toContain('CATEGORIES:Dairy');
          },
        },
      ],
    });

    tester.generateDocs();
  } finally {
    await server.close();
  }
});
