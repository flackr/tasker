import fsNode from 'node:fs';
import path from 'node:path';
import { parseVTodo } from '@tasker/core';
import { createMockCalDav } from '@tasker/mock-caldav';
import { describe, expect, it } from 'vitest';
import { createWatchApp, getListCacheFilename } from '../app/watch-app.js';
import { createCompanionSync } from '../companion/sync.js';

function createMemorySettings(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, val: string) => map.set(key, val),
  };
}

function createMemoryFs() {
  const files = new Map<string, unknown>();
  return {
    files,
    readFileSync: (name: string) => {
      if (!files.has(name)) throw new Error(`ENOENT: ${name}`);
      return JSON.parse(JSON.stringify(files.get(name)));
    },
    writeFileSync: (name: string, data: unknown) => {
      files.set(name, JSON.parse(JSON.stringify(data)));
    },
  };
}

interface MockTaskTile {
  display: string;
  checkbox: { text: string; value: number; onclick: (() => void) | null };
  category: { text: string };
}

interface MockListTile {
  display: string;
  title: { text: string };
  subtitle: { text: string };
  touch: { onclick: (() => void) | null };
}

function createMockWatchDocument(taskSlotCount = 20, listSlotCount = 10) {
  const status = { text: '' };
  const syncBtn = { onclick: null as (() => void) | null };
  const backBtn = {
    style: { display: 'none' },
    onclick: null as (() => void) | null,
  };
  const backBtnLabel = { text: 'Lists', style: { display: 'none' } };
  const listsView = { style: { display: 'none' } };
  const tasksView = { style: { display: 'inline' } };

  const taskTiles: MockTaskTile[] = [];
  for (let i = 0; i < taskSlotCount; i++) {
    taskTiles.push({
      display: 'none',
      checkbox: { text: '', value: 0, onclick: null },
      category: { text: '' },
    });
  }

  const listTiles: MockListTile[] = [];
  for (let i = 0; i < listSlotCount; i++) {
    listTiles.push({
      display: 'none',
      title: { text: '' },
      subtitle: { text: '' },
      touch: { onclick: null },
    });
  }

  const doc = {
    getElementById(id: string) {
      if (id === 'status') return status;
      if (id === 'sync-btn') return syncBtn;
      if (id === 'back-btn') return backBtn;
      if (id === 'back-btn-label') return backBtnLabel;
      if (id === 'lists-view') return listsView;
      if (id === 'tasks-view') return tasksView;

      const listMatch = /^list-item-(\d+)$/.exec(id);
      if (listMatch) {
        const idx = Number(listMatch[1]);
        if (idx >= listTiles.length) return null;
        const tile = listTiles[idx];
        return {
          getElementById(subId: string) {
            if (subId === 'list-tile-list') {
              return {
                style: {
                  get display() {
                    return tile.display;
                  },
                  set display(val: string) {
                    tile.display = val;
                  },
                },
              };
            }
            if (subId === 'list-title') return tile.title;
            if (subId === 'list-subtitle') return tile.subtitle;
            if (subId === 'list-touch') return tile.touch;
            return null;
          },
        };
      }

      const taskMatch = /^item-(\d+)$/.exec(id);
      if (taskMatch) {
        const idx = Number(taskMatch[1]);
        if (idx >= taskTiles.length) return null;
        const tile = taskTiles[idx];
        return {
          getElementById(subId: string) {
            if (subId === 'task-tile-list') {
              return {
                style: {
                  get display() {
                    return tile.display;
                  },
                  set display(val: string) {
                    tile.display = val;
                  },
                },
              };
            }
            if (subId === 'task-checkbox') return tile.checkbox;
            if (subId === 'item-category') return tile.category;
            return null;
          },
        };
      }
      return null;
    },
  };

  return { doc, status, syncBtn, backBtn, backBtnLabel, listsView, tasksView, taskTiles, listTiles };
}

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

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('Fitbit Watch multi-list navigation, local fs persistence, and timestamp reconciliation', () => {
  it('supports selecting between multiple lists, going back, and caching each list independently in fs', async () => {
    const backend = createMockCalDav({
      auth: { username: 'alice', password: 'secret' },
      calendars: [
        { slug: 'personal', displayName: 'Personal', components: ['VEVENT'] },
        { slug: 'shopping', displayName: 'Shopping', components: ['VTODO'] },
        { slug: 'hardware', displayName: 'Hardware', components: ['VTODO'] },
      ],
      tasks: [
        { uid: 'milk', calendarSlug: 'shopping', etag: 'e1', ics: makeIcs('milk', 'Milk', 'Dairy') },
        { uid: 'apples', calendarSlug: 'shopping', etag: 'e2', ics: makeIcs('apples', 'Apples', 'Produce') },
        { uid: 'nails', calendarSlug: 'hardware', etag: 'h1', ics: makeIcs('nails', 'Wood Screws', 'Fasteners') },
      ],
      files: [
        {
          path: 'Notes/tasker-config.json',
          content: JSON.stringify({ categories: ['Produce', 'Dairy'] }),
          contentType: 'application/json',
        },
      ],
    });

    const settingsStorage = createMemorySettings({
      app_server: JSON.stringify({ name: 'https://cloud.example.com' }),
      app_username: JSON.stringify({ name: 'alice' }),
      app_password: JSON.stringify({ name: 'secret' }),
      app_config_path: JSON.stringify({ name: 'Notes/tasker-config.json' }),
    });

    const fs = createMemoryFs();
    const ui = createMockWatchDocument();

    let watchApp: ReturnType<typeof createWatchApp>;
    const companion = createCompanionSync({
      settingsStorage,
      fetch: backend.createFetch(),
      maxChunkBytes: 220, // Exercise chunked TASKS_CHUNK transfer too
      send: (msg: unknown) => watchApp.onMessage(msg),
    });

    watchApp = createWatchApp({
      document: ui.doc,
      fs,
      send: (msg: unknown) => void companion.onMessage(msg),
    });

    watchApp.start();
    await flushPromises();

    // Multiple VTODO lists available → lands on lists view (VEVENT-only Personal excluded)
    expect(ui.listsView.style.display).toBe('inline');
    expect(ui.tasksView.style.display).toBe('none');
    expect(ui.backBtn.style.display).toBe('none');
    expect(ui.status.text).toBe('Lists (2)');
    expect(ui.listTiles[0].title.text).toBe('Shopping');
    expect(ui.listTiles[1].title.text).toBe('Hardware');
    expect(ui.listTiles[2].display).toBe('none');

    // Select Shopping → top-level tasks view
    ui.listTiles[0].touch.onclick!();
    await flushPromises();
    expect(ui.tasksView.style.display).toBe('inline');
    expect(ui.backBtn.style.display).toBe('inline');
    expect(ui.backBtnLabel.text).toBe('Lists');
    expect(ui.status.text).toBe('2 left');
    expect(ui.taskTiles[0].checkbox.text).toBe('Apples'); // Produce before Dairy
    expect(ui.taskTiles[1].checkbox.text).toBe('Milk');

    // Hardware Back from top-level tasks view returns false (lets Versa 2 exit app cleanly)
    // and keeps activeCalendarHref remembered in tasker-lists.json!
    expect(watchApp.goBack()).toBe(false);
    expect(ui.tasksView.style.display).toBe('inline');
    expect((fs.files.get('tasker-lists.json') as { activeCalendarHref?: string }).activeCalendarHref).toBe(
      '/remote.php/dav/calendars/alice/shopping/',
    );

    // Tap header "Lists" button → opens Lists sub-view without clearing activeCalendarHref
    ui.backBtn.onclick!();
    await flushPromises();
    expect(ui.listsView.style.display).toBe('inline');
    expect(ui.tasksView.style.display).toBe('none');
    expect(ui.backBtn.style.display).toBe('inline');
    expect(ui.backBtnLabel.text).toBe('Back');
    expect(ui.listTiles[0].subtitle.text).toBe('2 left');
    expect(ui.listTiles[1].subtitle.text).toBe('Tap to load');

    // Hardware Back from Lists sub-view returns true and returns to remembered Shopping list
    expect(watchApp.goBack()).toBe(true);
    expect(ui.tasksView.style.display).toBe('inline');
    expect(ui.listsView.style.display).toBe('none');
    expect(ui.backBtnLabel.text).toBe('Lists');
    expect(ui.taskTiles[0].checkbox.text).toBe('Apples');

    // Open Lists sub-view again and switch to Hardware
    ui.backBtn.onclick!();
    await flushPromises();
    ui.listTiles[1].touch.onclick!();
    await flushPromises();
    expect(ui.status.text).toBe('1 left');
    expect(ui.taskTiles[0].checkbox.text).toBe('Wood Screws');
    expect((fs.files.get('tasker-lists.json') as { activeCalendarHref?: string }).activeCalendarHref).toBe(
      '/remote.php/dav/calendars/alice/hardware/',
    );

    // Verify separate per-list files exist in Fitbit fs
    const shoppingFile = getListCacheFilename('/remote.php/dav/calendars/alice/shopping/');
    const hardwareFile = getListCacheFilename('/remote.php/dav/calendars/alice/hardware/');
    expect(fs.files.has('tasker-lists.json')).toBe(true);
    expect(fs.files.has(shoppingFile)).toBe(true);
    expect(fs.files.has(hardwareFile)).toBe(true);
  });

  it('displays remembered list immediately on Versa 2 relaunch before Bluetooth opens, then syncs updates in background', async () => {
    const backend = createMockCalDav({
      auth: { username: 'alice', password: 'secret' },
      calendars: [
        { slug: 'shopping', displayName: 'Shopping', components: ['VTODO'] },
        { slug: 'hardware', displayName: 'Hardware', components: ['VTODO'] },
      ],
      tasks: [
        { uid: 'milk', calendarSlug: 'shopping', etag: 'e1', ics: makeIcs('milk', 'Milk', 'Dairy') },
        { uid: 'apples', calendarSlug: 'shopping', etag: 'e2', ics: makeIcs('apples', 'Apples', 'Produce') },
      ],
    });
    const settingsStorage = createMemorySettings({
      app_server: JSON.stringify({ name: 'https://cloud.example.com' }),
      app_username: JSON.stringify({ name: 'alice' }),
      app_password: JSON.stringify({ name: 'secret' }),
    });
    const fs = createMemoryFs();

    // Session 1: pick Shopping, load tasks, then press hardware Back to exit
    const ui1 = createMockWatchDocument();
    let watchApp: ReturnType<typeof createWatchApp>;
    const companion1 = createCompanionSync({
      settingsStorage,
      fetch: backend.createFetch(),
      send: (msg: unknown) => watchApp.onMessage(msg),
    });
    watchApp = createWatchApp({
      document: ui1.doc,
      fs,
      send: (msg: unknown) => void companion1.onMessage(msg),
    });
    watchApp.start();
    await flushPromises();
    ui1.listTiles[0].touch.onclick!();
    await flushPromises();
    expect(ui1.status.text).toBe('2 left');
    expect(watchApp.goBack()).toBe(false); // Exits app cleanly without forgetting Shopping

    // Meanwhile another device adds "Bread" on Nextcloud
    backend.setTask({
      uid: 'bread',
      calendarSlug: 'shopping',
      etag: 'e3',
      ics: makeIcs('bread', 'Bread', 'Bakery'),
    });

    // Session 2: relaunch with Bluetooth initially CLOSED (real Versa 2 boot behavior)
    let connected = false;
    const sentTypes: string[] = [];
    const ui2 = createMockWatchDocument();
    const deliveredReplies: (() => void)[] = [];
    const companion2 = createCompanionSync({
      settingsStorage,
      fetch: backend.createFetch(),
      send: (msg: unknown) => deliveredReplies.push(() => watchApp.onMessage(msg)),
    });
    watchApp = createWatchApp({
      document: ui2.doc,
      fs,
      isConnected: () => connected,
      send: (msg: { type: string }) => {
        sentTypes.push(msg.type);
        void companion2.onMessage(msg);
      },
    });
    watchApp.start();

    // Saved Shopping list is displayed IMMEDIATELY before Bluetooth opens
    expect(ui2.tasksView.style.display).toBe('inline');
    expect(ui2.listsView.style.display).toBe('none');
    expect(ui2.taskTiles[0].checkbox.text).toBe('Apples');
    expect(ui2.taskTiles[1].checkbox.text).toBe('Milk');
    expect(sentTypes).toEqual([]);

    // Bluetooth peerSocket opens → triggers background FETCH_TASKS while cached items remain visible
    connected = true;
    watchApp.onConnectionChange(true);
    expect(sentTypes).toEqual(['FETCH_TASKS']);
    expect(ui2.status.text).toBe('Syncing...');
    expect(ui2.taskTiles[0].checkbox.text).toBe('Apples');
    expect(ui2.taskTiles[1].checkbox.text).toBe('Milk');

    // Background reply arrives with new item from Nextcloud
    await flushPromises();
    while (deliveredReplies.length > 0) {
      deliveredReplies.shift()!();
    }
    expect(ui2.status.text).toBe('3 left');
    const renderedSummaries = [0, 1, 2].map((i) => ui2.taskTiles[i].checkbox.text);
    expect(renderedSummaries).toContain('Bread');
  });

  it('defines explicit 58px tile heights in Fitbit GUI and CSS so Versa 2 renders multiple list items at once', () => {
    const gui = fsNode.readFileSync(path.resolve(__dirname, '../resources/index.gui'), 'utf8');
    const css = fsNode.readFileSync(path.resolve(__dirname, '../resources/styles.css'), 'utf8');
    expect(css).toMatch(/\.tile-list-item\s*\{[^}]*height:\s*58;/);
    expect(gui).toMatch(/<symbol\s+id="list-item"\s+height="58">/);
    expect(gui).toMatch(/<use\s+id="list-tile-list"\s+href="#tile-list-item"\s+class="tile-list-item"\s+height="58">/);
  });

  it('sorts each task list using its own per-calendar categoriesByCalendar order', async () => {
    const shoppingHref = '/remote.php/dav/calendars/alice/shopping/';
    const hardwareHref = '/remote.php/dav/calendars/alice/hardware/';
    const backend = createMockCalDav({
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
            categoriesByCalendar: {
              [shoppingHref]: ['Produce', 'Dairy'],
              [hardwareHref]: ['Electrical', 'Fasteners'],
            },
          }),
          contentType: 'application/json',
        },
      ],
    });
    const settingsStorage = createMemorySettings({
      app_server: JSON.stringify({ name: 'https://cloud.example.com' }),
      app_username: JSON.stringify({ name: 'alice' }),
      app_password: JSON.stringify({ name: 'secret' }),
      app_config_path: JSON.stringify({ name: 'Notes/tasker-config.json' }),
    });
    const fs = createMemoryFs();
    const ui = createMockWatchDocument();
    let watchApp: ReturnType<typeof createWatchApp>;
    const companion = createCompanionSync({
      settingsStorage,
      fetch: backend.createFetch(),
      send: (msg: unknown) => watchApp.onMessage(msg),
    });
    watchApp = createWatchApp({
      document: ui.doc,
      fs,
      send: (msg: unknown) => void companion.onMessage(msg),
    });

    watchApp.start();
    await flushPromises();

    // Open Shopping → Produce before Dairy
    ui.listTiles[0].touch.onclick!();
    await flushPromises();
    expect(ui.taskTiles[0].checkbox.text).toBe('Apples');
    expect(ui.taskTiles[1].checkbox.text).toBe('Milk');

    // Switch to Hardware → Electrical before Fasteners
    ui.backBtn.onclick!();
    await flushPromises();
    ui.listTiles[1].touch.onclick!();
    await flushPromises();
    expect(ui.taskTiles[0].checkbox.text).toBe('Romex Wire');
    expect(ui.taskTiles[1].checkbox.text).toBe('Wood Screws');
  });

  it('immediately renders cached list on restart and reconciles: newer server edits win, newer watch toggles sync up', async () => {
    const tBase = Date.parse('2026-05-01T10:00:00.000Z');
    const tWatchOffline = Date.parse('2026-05-01T10:05:00.000Z');
    const tServerNewer = '20260501T101000Z'; // 10:10 > watch's 10:05 → server wins!
    const tServerOlder = '20260501T100200Z'; // 10:02 < watch's 10:05 → watch wins!

    const backend = createMockCalDav({
      auth: { username: 'alice', password: 'secret' },
      tasks: [
        {
          uid: 'milk',
          calendarSlug: 'shopping',
          etag: 'e1',
          ics: makeIcs('milk', 'Milk', 'Dairy', {
            status: 'NEEDS-ACTION',
            lastModified: '20260501T100000Z',
            extra: 'X-OC-HIDESUBTASKS:0',
          }),
        },
        {
          uid: 'apples',
          calendarSlug: 'shopping',
          etag: 'e2',
          ics: makeIcs('apples', 'Apples', 'Produce', {
            status: 'NEEDS-ACTION',
            lastModified: '20260501T100000Z',
            extra: 'X-PRESERVE:yes',
          }),
        },
      ],
      files: [
        {
          path: 'Notes/tasker-config.json',
          content: JSON.stringify({
            defaultCalendarHref: '/remote.php/dav/calendars/alice/shopping/',
            categories: ['Produce', 'Dairy'],
          }),
          contentType: 'application/json',
        },
      ],
    });

    const settingsStorage = createMemorySettings({
      app_server: JSON.stringify({ name: 'https://cloud.example.com' }),
      app_username: JSON.stringify({ name: 'alice' }),
      app_password: JSON.stringify({ name: 'secret' }),
      app_config_path: JSON.stringify({ name: 'Notes/tasker-config.json' }),
    });

    const fs = createMemoryFs();
    let connected = true;
    let clockMs = tBase;

    const ui1 = createMockWatchDocument();
    let watchApp: ReturnType<typeof createWatchApp>;
    const companion = createCompanionSync({
      settingsStorage,
      fetch: backend.createFetch(),
      send: (msg: unknown) => {
        if (connected) watchApp.onMessage(msg);
      },
    });

    watchApp = createWatchApp({
      document: ui1.doc,
      fs,
      now: () => clockMs,
      isConnected: () => connected,
      send: (msg: unknown) => {
        if (connected) void companion.onMessage(msg);
      },
    });

    // Initial sync auto-opens default Shopping list
    watchApp.start();
    await flushPromises();
    expect(ui1.status.text).toBe('2 left');

    // Go offline and check off BOTH Apples and Milk at 10:05
    connected = false;
    watchApp.onConnectionChange(false);
    clockMs = tWatchOffline;
    ui1.taskTiles[0].checkbox.onclick!(); // Apples → completed at 10:05
    ui1.taskTiles[1].checkbox.onclick!(); // Milk → completed at 10:05
    expect(ui1.status.text).toBe('Offline (2 pending)');

    // While watch is offline:
    // - Server updates Milk at 10:10 (NEWER than 10:05) keeping it NEEDS-ACTION ("Organic Milk")
    // - Server updates Apples summary at 10:02 (OLDER than 10:05) keeping it NEEDS-ACTION ("Honeycrisp Apples")
    backend.setTask({
      uid: 'milk',
      calendarSlug: 'shopping',
      etag: 'e1-newer',
      ics: makeIcs('milk', 'Organic Milk', 'Dairy', {
        status: 'NEEDS-ACTION',
        lastModified: tServerNewer,
        extra: 'X-OC-HIDESUBTASKS:0',
      }),
    });
    backend.setTask({
      uid: 'apples',
      calendarSlug: 'shopping',
      etag: 'e2-older',
      ics: makeIcs('apples', 'Honeycrisp Apples', 'Produce', {
        status: 'NEEDS-ACTION',
        lastModified: tServerOlder,
        extra: 'X-PRESERVE:yes',
      }),
    });

    // Restart watch app while connected, capturing outgoing messages before async replies settle
    connected = true;
    const ui2 = createMockWatchDocument();
    const deliveredReplies: (() => void)[] = [];
    const companion2 = createCompanionSync({
      settingsStorage,
      fetch: backend.createFetch(),
      send: (msg: unknown) => {
        deliveredReplies.push(() => watchApp.onMessage(msg));
      },
    });

    watchApp = createWatchApp({
      document: ui2.doc,
      fs,
      now: () => clockMs,
      isConnected: () => connected,
      send: (msg: unknown) => void companion2.onMessage(msg),
    });

    watchApp.start();

    // IMMEDIATELY (synchronously before ANY server reply!), watch renders stored list from fs!
    expect(ui2.tasksView.style.display).toBe('inline');
    expect(ui2.taskTiles[0].checkbox.text).toBe('Apples');
    expect(ui2.taskTiles[0].checkbox.value).toBe(1);
    expect(ui2.taskTiles[1].checkbox.text).toBe('Milk');
    expect(ui2.taskTiles[1].checkbox.value).toBe(1);
    expect(ui2.status.text).toBe('Syncing...');

    // Now let Companion async fetches and replies drain
    for (let round = 0; round < 5; round++) {
      await flushPromises();
      while (deliveredReplies.length > 0) {
        deliveredReplies.shift()!();
      }
    }

    // Verify reconciliation outcome:
    // - Milk (server 10:10 > watch 10:05): server won! Still NEEDS-ACTION ("Organic Milk"), NOT overwritten on server!
    // - Apples (watch 10:05 > server 10:02): watch won! Synced COMPLETED up to server preserving server summary + X-PRESERVE!
    expect(ui2.status.text).toBe('1 left');
    expect(ui2.taskTiles[0].checkbox.text).toBe('Honeycrisp Apples');
    expect(ui2.taskTiles[0].checkbox.value).toBe(1);
    expect(ui2.taskTiles[1].checkbox.text).toBe('Organic Milk');
    expect(ui2.taskTiles[1].checkbox.value).toBe(0);

    const finalMilk = parseVTodo(backend.getTasks('shopping').find((t) => t.uid === 'milk')!.ics);
    const finalApples = parseVTodo(backend.getTasks('shopping').find((t) => t.uid === 'apples')!.ics);
    expect(finalMilk.status).toBe('NEEDS-ACTION');
    expect(finalMilk.summary).toBe('Organic Milk');
    expect(finalApples.status).toBe('COMPLETED');
    expect(finalApples.summary).toBe('Honeycrisp Apples');
    expect(finalApples.rawIcs).toContain('X-PRESERVE:yes');
  });

  it('prefers newer server change on 412 conflict during in-flight UPDATE_TASK', async () => {
    const backend = createMockCalDav({
      auth: { username: 'alice', password: 'secret' },
      tasks: [
        {
          uid: 'milk',
          calendarSlug: 'shopping',
          etag: 'e1',
          ics: makeIcs('milk', 'Milk', 'Dairy', {
            status: 'NEEDS-ACTION',
            lastModified: '20260501T100000Z',
          }),
        },
      ],
    });

    const settingsStorage = createMemorySettings({
      app_server: JSON.stringify({ name: 'https://cloud.example.com' }),
      app_username: JSON.stringify({ name: 'alice' }),
      app_password: JSON.stringify({ name: 'secret' }),
    });

    const fs = createMemoryFs();
    const ui = createMockWatchDocument();
    let watchApp: ReturnType<typeof createWatchApp>;
    const companion = createCompanionSync({
      settingsStorage,
      fetch: backend.createFetch(),
      send: (msg: unknown) => watchApp.onMessage(msg),
    });

    watchApp = createWatchApp({
      document: ui.doc,
      fs,
      now: () => Date.parse('2026-05-01T10:05:00.000Z'),
      send: (msg: unknown) => void companion.onMessage(msg),
    });

    watchApp.start();
    await flushPromises();
    expect(ui.status.text).toBe('1 left');

    // Another device updates Milk at 10:15 (strictly newer than watch's 10:05 toggle)
    backend.setTask({
      uid: 'milk',
      calendarSlug: 'shopping',
      etag: 'e2-newer',
      ics: makeIcs('milk', 'Milk', 'Dairy', {
        status: 'NEEDS-ACTION',
        lastModified: '20260501T101500Z',
      }),
    });

    // Watch taps Milk at 10:05 → Companion hits 412, refreshes, sees 10:15 > 10:05 → server wins!
    ui.taskTiles[0].checkbox.onclick!();
    await flushPromises();

    expect(ui.taskTiles[0].checkbox.value).toBe(0);
    expect(ui.status.text).toBe('1 left');
    const serverMilk = parseVTodo(backend.getTasks('shopping')[0].ics);
    expect(serverMilk.status).toBe('NEEDS-ACTION');
  });

  it('surfaces clear error message when credentials are missing', async () => {
    const fs = createMemoryFs();
    const ui = createMockWatchDocument();
    let watchApp: ReturnType<typeof createWatchApp>;
    const companion = createCompanionSync({
      settingsStorage: createMemorySettings(),
      send: (msg: unknown) => watchApp.onMessage(msg),
    });
    watchApp = createWatchApp({
      document: ui.doc,
      fs,
      send: (msg: unknown) => void companion.onMessage(msg),
    });

    watchApp.start();
    await flushPromises();
    expect(ui.status.text).toContain('Err:');
    expect(ui.status.text).toContain('credentials');
  });
});
