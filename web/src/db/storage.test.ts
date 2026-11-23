import { createMockCalDav } from '@tasker/mock-caldav';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  bootstrapRemoteConfig,
  clearCredentials,
  createRemoteConfig,
  fetchRemoteConfig,
  loadCredentials,
  saveCredentials,
} from '../auth';
import {
  clearAllLocalData,
  DEFAULT_CATEGORIES,
  IndexedDbSyncStorage,
  loadAutoCategorize,
  loadCategoryOrder,
  loadTaskerConfig,
  saveAutoCategorize,
  saveCategoryOrder,
} from './storage';

describe('IndexedDbSyncStorage and settings persistence', () => {
  const storage = new IndexedDbSyncStorage();

  beforeEach(async () => {
    await clearAllLocalData();
  });

  it('stores, queries by calendar, updates, and deletes tasks', async () => {
    await storage.tasks.putTask({
      uid: 't1',
      calendarHref: '/cal/shopping/',
      summary: 'Milk',
      status: 'NEEDS-ACTION',
      categories: ['Dairy'],
    });
    await storage.tasks.putTask({
      uid: 't2',
      calendarHref: '/cal/work/',
      summary: 'Slides',
      status: 'NEEDS-ACTION',
      categories: [],
    });

    expect((await storage.tasks.getTask('t1'))?.summary).toBe('Milk');
    const shopping = await storage.tasks.getTasksByCalendar('/cal/shopping/');
    expect(shopping.map((t) => t.uid)).toEqual(['t1']);

    await storage.tasks.deleteTask('t1');
    expect(await storage.tasks.getTask('t1')).toBeUndefined();
  });

  it('stores calendar metadata and FIFO sync queue entries', async () => {
    await storage.calendars.putCalendar({
      href: '/cal/shopping/',
      displayName: 'Shopping',
      ctag: 'ctag-1',
    });
    expect(await storage.calendars.getCalendar('/cal/shopping/')).toEqual({
      href: '/cal/shopping/',
      displayName: 'Shopping',
      ctag: 'ctag-1',
    });

    const id1 = await storage.queue.enqueue({
      type: 'create',
      uid: 'u1',
      calendarHref: '/cal/shopping/',
      queuedAt: '2026-05-01T10:00:00.000Z',
    });
    const id2 = await storage.queue.enqueue({
      type: 'update',
      uid: 'u2',
      calendarHref: '/cal/shopping/',
      queuedAt: '2026-05-01T10:01:00.000Z',
    });

    const list = await storage.queue.list();
    expect(list.map((op) => op.id)).toEqual([id1, id2]);

    await storage.queue.remove(id1);
    expect((await storage.queue.list()).map((op) => op.id)).toEqual([id2]);
  });

  it('persists category order, auto-categorize toggle, bootstraps tasker-config.json, and clears on logout', async () => {
    expect(await loadCategoryOrder()).toEqual(DEFAULT_CATEGORIES);
    await saveCategoryOrder(['Produce', 'Dairy']);
    expect(await loadCategoryOrder()).toEqual(['Produce', 'Dairy']);

    expect(await loadAutoCategorize()).toBe(false);
    await saveAutoCategorize(true);
    expect(await loadAutoCategorize()).toBe(true);

    const backend = createMockCalDav({
      auth: { username: 'alice', password: 'secret' },
      files: [
        {
          path: 'Notes/tasker-config.json',
          content: JSON.stringify({
            defaultCalendarHref: '/remote.php/dav/calendars/alice/shopping/',
            categories: ['Fruits', 'Bread', 'Dairy'],
            recipesPath: 'Recipes',
          }),
          contentType: 'application/json',
        },
      ],
    });

    const creds = {
      baseUrl: 'https://cloud.example.com',
      username: 'alice',
      appPassword: 'secret',
      configPath: 'Notes/tasker-config.json',
    };
    await saveCredentials(creds);
    const cfg = await bootstrapRemoteConfig(creds, backend.createFetch());
    expect(cfg?.recipesPath).toBe('Recipes');
    expect(await loadCategoryOrder()).toEqual(['Fruits', 'Bread', 'Dairy']);
    expect((await loadTaskerConfig())?.defaultCalendarHref).toBe(
      '/remote.php/dav/calendars/alice/shopping/',
    );

    await clearCredentials();
    expect(await loadCredentials()).toBeUndefined();
    expect(await loadCategoryOrder()).toEqual(DEFAULT_CATEGORIES);
    expect(await loadAutoCategorize()).toBe(false);
  });

  it('reports not_found when remote config does not exist and creates it on demand', async () => {
    const backend = createMockCalDav({
      auth: { username: 'alice', password: 'secret' },
    });
    const creds = {
      baseUrl: 'https://cloud.example.com',
      username: 'alice',
      appPassword: 'secret',
      configPath: 'Notes/tasker-config.json',
    };

    const missing = await fetchRemoteConfig(creds, backend.createFetch());
    expect(missing).toEqual({ status: 'not_found', path: 'Notes/tasker-config.json' });

    await createRemoteConfig(
      creds,
      { categories: ['Produce', 'Bakery', 'Dairy'] },
      backend.createFetch(),
    );

    const createdContent = backend.getFile('Notes/tasker-config.json');
    expect(createdContent).toBeTruthy();
    expect(JSON.parse(createdContent!)).toEqual({
      categories: ['Produce', 'Bakery', 'Dairy'],
    });

    const loaded = await fetchRemoteConfig(creds, backend.createFetch());
    expect(loaded).toEqual({
      status: 'loaded',
      config: { categories: ['Produce', 'Bakery', 'Dairy'] },
    });
    expect(await loadCategoryOrder()).toEqual(['Produce', 'Bakery', 'Dairy']);
  });
});
