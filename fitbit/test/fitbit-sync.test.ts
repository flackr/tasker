import fsNode from 'node:fs';
import path from 'node:path';
import { parseVTodo } from '@tasker/core';
import { createMockCalDav } from '@tasker/mock-caldav';
import { describe, expect, it } from 'vitest';
import { buildTaskRows, createWatchApp, getListCacheFilename } from '../app/watch-app.js';
import { createCompanionSync } from '../companion/sync.js';

function createMemorySettings(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, val: string) => map.set(key, val),
  };
}

function assertNoUndefinedValues(value: unknown, pathLabel = 'root'): void {
  if (value === undefined) {
    throw new Error(`Undefined value not allowed in CBOR payload at ${pathLabel}`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, idx) => assertNoUndefinedValues(item, `${pathLabel}[${idx}]`));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      assertNoUndefinedValues(val, `${pathLabel}.${key}`);
    }
  }
}

function createMemoryFs() {
  const files = new Map<string, unknown>();
  const encodings = new Map<string, string>();
  const validEncodings = new Set(['cbor', 'json', 'utf-8', 'ascii']);
  return {
    files,
    encodings,
    readFileSync: (name: string, encoding?: string) => {
      if (!encoding || !validEncodings.has(encoding)) {
        throw new Error(`Invalid Fitbit fs encoding: ${String(encoding)}`);
      }
      if (!files.has(name)) throw new Error(`ENOENT: ${name}`);
      const storedEnc = encodings.get(name);
      if (storedEnc && storedEnc !== encoding) {
        throw new Error(`Encoding mismatch for ${name}: ${storedEnc} vs ${encoding}`);
      }
      return JSON.parse(JSON.stringify(files.get(name)));
    },
    writeFileSync: (name: string, data: unknown, encoding?: string) => {
      if (!encoding || !validEncodings.has(encoding)) {
        throw new Error(`Invalid Fitbit fs encoding: ${String(encoding)}`);
      }
      if (!name || name.startsWith('/') || name.length > 24) {
        throw new Error(`Unsafe Fitbit fs filename: ${name}`);
      }
      if (encoding === 'cbor') {
        assertNoUndefinedValues(data, name);
      }
      files.set(name, JSON.parse(JSON.stringify(data)));
      encodings.set(name, encoding);
    },
  };
}

interface MockStaticRowSlot {
  display: string;
  categoryDisplay: string;
  categoryTitle: string;
  taskDisplay: string;
  taskTitle: string;
  taskTitleFill: string;
  checked: boolean;
  onclick: (() => void) | null;
}

interface MockListTileSlot {
  display: string;
  title: string;
  subtitle: string;
  onclick: (() => void) | null;
}

function createMockWatchDocument(rowSlotCount = 40, listSlotCount = 12) {
  const status = { text: '' };
  const pageHint = { text: '' };
  const activeListLabel = { text: '' };
  const syncLabel = { text: 'Sync' };
  const syncTouch = { onclick: null as (() => void) | null };
  const autohideLabel = { text: 'Autohide' };
  const autohideTouch = {
    style: { fill: '#374151' },
    onclick: null as (() => void) | null,
  };
  const listsSyncLabel = { text: 'Sync Lists' };
  const listsSyncTouch = { onclick: null as (() => void) | null };

  let panoramaValue = 0;
  let onvaluechange: (() => void) | null = null;
  const listeners = new Map<string, Array<() => void>>();

  const container = {
    get value() { return panoramaValue; },
    set value(v: number) { panoramaValue = v; },
    get onvaluechange() { return onvaluechange; },
    set onvaluechange(fn: (() => void) | null) { onvaluechange = fn; },
    addEventListener(evt: string, fn: () => void) {
      const list = listeners.get(evt) ?? [];
      list.push(fn);
      listeners.set(evt, list);
    },
    swipeTo(page: number) {
      panoramaValue = page;
      if (onvaluechange) onvaluechange();
      for (const fn of listeners.get('select') ?? []) fn();
    },
  };

  const rowSlots: MockStaticRowSlot[] = [];
  for (let i = 0; i < rowSlotCount; i++) {
    rowSlots.push({
      display: 'none',
      categoryDisplay: 'none',
      categoryTitle: '',
      taskDisplay: 'none',
      taskTitle: '',
      taskTitleFill: '#ffffff',
      checked: false,
      onclick: null,
    });
  }

  const listSlots: MockListTileSlot[] = [];
  for (let i = 0; i < listSlotCount; i++) {
    listSlots.push({
      display: 'none',
      title: '',
      subtitle: '',
      onclick: null,
    });
  }

  const checklist = {
    value: 0,
    get visibleCategories(): string[] {
      return rowSlots
        .filter((s) => s.display !== 'none' && s.categoryDisplay !== 'none')
        .map((s) => s.categoryTitle);
    },
    get visibleTasks(): MockStaticRowSlot[] {
      return rowSlots.filter((s) => s.display !== 'none' && s.taskDisplay !== 'none');
    },
  };

  const listsChecklist = {
    value: 0,
    get visibleLists(): MockListTileSlot[] {
      return listSlots.filter((s) => s.display !== 'none');
    },
  };

  const doc = {
    getElementById(id: string) {
      if (id === 'status') return status;
      if (id === 'page-hint') return pageHint;
      if (id === 'container') return container;
      if (id === 'checklist') return checklist;
      if (id === 'lists-checklist') return listsChecklist;
      if (id === 'top-spacer-row') {
        return {
          getElementById(subId: string) {
            return subId === 'active-list-label' ? activeListLabel : null;
          },
        };
      }
      if (id === 'actions-row') {
        return {
          getElementById(subId: string) {
            if (subId === 'sync-label') return syncLabel;
            if (subId === 'sync-touch') return syncTouch;
            if (subId === 'autohide-label') return autohideLabel;
            if (subId === 'autohide-touch') return autohideTouch;
            return null;
          },
        };
      }
      if (id === 'lists-sync-row') {
        return {
          getElementById(subId: string) {
            if (subId === 'lists-sync-label') return listsSyncLabel;
            if (subId === 'lists-sync-touch') return listsSyncTouch;
            return null;
          },
        };
      }

      const rowMatch = /^row-(\d+)$/.exec(id);
      if (rowMatch) {
        const idx = Number(rowMatch[1]);
        if (idx >= rowSlots.length) return null;
        const slot = rowSlots[idx];
        return {
          getElementById(subId: string) {
            if (subId === 'row-tile-list') {
              return {
                style: {
                  get display() { return slot.display; },
                  set display(v: string) { slot.display = v; },
                },
              };
            }
            if (subId === 'category-group') {
              return {
                style: {
                  get display() { return slot.categoryDisplay; },
                  set display(v: string) { slot.categoryDisplay = v; },
                },
              };
            }
            if (subId === 'category-title') {
              return {
                get text() { return slot.categoryTitle; },
                set text(v: string) { slot.categoryTitle = v; },
              };
            }
            if (subId === 'task-group') {
              return {
                style: {
                  get display() { return slot.taskDisplay; },
                  set display(v: string) { slot.taskDisplay = v; },
                },
              };
            }
            if (subId === 'task-title') {
              return {
                get text() { return slot.taskTitle; },
                set text(v: string) { slot.taskTitle = v; },
                style: {
                  get fill() { return slot.taskTitleFill; },
                  set fill(v: string) { slot.taskTitleFill = v; },
                },
              };
            }
            if (subId === 'checkbox-check') {
              return {
                style: {
                  get display() { return slot.checked ? 'inline' : 'none'; },
                  set display(v: string) { slot.checked = v !== 'none'; },
                },
              };
            }
            if (subId === 'task-touch') {
              return {
                get onclick() { return slot.onclick; },
                set onclick(fn: (() => void) | null) { slot.onclick = fn; },
              };
            }
            return null;
          },
        };
      }

      const listMatch = /^list-item-(\d+)$/.exec(id);
      if (listMatch) {
        const idx = Number(listMatch[1]);
        if (idx >= listSlots.length) return null;
        const slot = listSlots[idx];
        return {
          getElementById(subId: string) {
            if (subId === 'list-tile-list') {
              return {
                style: {
                  get display() { return slot.display; },
                  set display(v: string) { slot.display = v; },
                },
              };
            }
            if (subId === 'list-title') {
              return {
                get text() { return slot.title; },
                set text(v: string) { slot.title = v; },
              };
            }
            if (subId === 'list-subtitle') {
              return {
                get text() { return slot.subtitle; },
                set text(v: string) { slot.subtitle = v; },
              };
            }
            if (subId === 'list-touch') {
              return {
                get onclick() { return slot.onclick; },
                set onclick(fn: (() => void) | null) { slot.onclick = fn; },
              };
            }
            return null;
          },
        };
      }

      return null;
    },
  };

  return {
    doc,
    status,
    pageHint,
    activeListLabel,
    syncLabel,
    syncTouch,
    autohideLabel,
    autohideTouch,
    listsSyncLabel,
    listsSyncTouch,
    container,
    checklist,
    listsChecklist,
  };
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

describe('Fitbit Watch panorama navigation, static tile list, autohide, local fs persistence, and reconciliation', () => {
  it('groups consecutive tasks under single category header rows and filters completed items in Autohide mode', () => {
    const items = [
      { uid: '1', summary: 'Apples', categories: ['Produce'], completed: false },
      { uid: '2', summary: 'Bananas', categories: ['Produce'], completed: true },
      { uid: '3', summary: 'Milk', categories: ['Dairy'], completed: true },
      { uid: '4', summary: 'Napkins', categories: [], completed: false },
    ];

    expect(buildTaskRows(items)).toEqual([
      { kind: 'category', category: 'Produce' },
      { kind: 'task', taskIndex: 0 },
      { kind: 'task', taskIndex: 1 },
      { kind: 'category', category: 'Dairy' },
      { kind: 'task', taskIndex: 2 },
      { kind: 'category', category: 'Uncategorized' },
      { kind: 'task', taskIndex: 3 },
    ]);

    expect(buildTaskRows(items, { hideCompleted: true })).toEqual([
      { kind: 'category', category: 'Produce' },
      { kind: 'task', taskIndex: 0 },
      { kind: 'category', category: 'Uncategorized' },
      { kind: 'task', taskIndex: 3 },
    ]);
  });

  it('toggles between Autohide and Show All, immediately hides checked items, and persists hideCompleted in t-lists.cbor', async () => {
    const backend = createMockCalDav({
      auth: { username: 'alice', password: 'secret' },
      tasks: [
        { uid: 'apples', calendarSlug: 'shopping', etag: 'e1', ics: makeIcs('apples', 'Apples', 'Produce', { status: 'COMPLETED' }) },
        { uid: 'milk', calendarSlug: 'shopping', etag: 'e2', ics: makeIcs('milk', 'Milk', 'Dairy') },
        { uid: 'cheese', calendarSlug: 'shopping', etag: 'e3', ics: makeIcs('cheese', 'Cheese', 'Dairy') },
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
      send: (msg: unknown) => watchApp.onMessage(msg),
    });
    watchApp = createWatchApp({
      document: ui.doc,
      fs,
      send: (msg: unknown) => void companion.onMessage(msg),
    });

    watchApp.start();
    await flushPromises();

    expect(ui.autohideLabel.text).toBe('Autohide');
    expect(ui.checklist.visibleCategories).toEqual(['Produce', 'Dairy']);
    expect(ui.checklist.visibleTasks.map((t) => t.taskTitle)).toEqual(['Apples', 'Cheese', 'Milk']);

    ui.autohideTouch.onclick!();
    expect(watchApp.getState().hideCompleted).toBe(true);
    expect(ui.autohideLabel.text).toBe('Show All');
    expect(ui.checklist.visibleCategories).toEqual(['Dairy']);
    expect(ui.checklist.visibleTasks.map((t) => t.taskTitle)).toEqual(['Cheese', 'Milk']);
    expect((fs.files.get('t-lists.cbor') as { hideCompleted?: boolean }).hideCompleted).toBe(true);

    ui.checklist.visibleTasks[0].onclick!();
    expect(ui.checklist.visibleTasks.map((t) => t.taskTitle)).toEqual(['Milk']);

    ui.checklist.visibleTasks[0].onclick!();
    expect(ui.checklist.visibleTasks).toEqual([]);
    expect(ui.checklist.value).toBe(0);

    const ui2 = createMockWatchDocument();
    const watchApp2 = createWatchApp({
      document: ui2.doc,
      fs,
      isConnected: () => false,
      send: () => {},
    });
    watchApp2.start();
    expect(watchApp2.getState().hideCompleted).toBe(true);
    expect(ui2.autohideLabel.text).toBe('Show All');
    expect(ui2.checklist.visibleTasks).toEqual([]);

    ui2.autohideTouch.onclick!();
    expect(watchApp2.getState().hideCompleted).toBe(false);
    expect(ui2.autohideLabel.text).toBe('Autohide');
    expect(ui2.checklist.visibleTasks.map((t) => t.taskTitle)).toEqual(['Apples', 'Cheese', 'Milk']);
  });

  it('supports swiping to Lists via #panoramaview, going back, pull-down Sync button, and independent CBOR fs caches', async () => {
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
        { uid: 'bananas', calendarSlug: 'shopping', etag: 'e3', ics: makeIcs('bananas', 'Bananas', 'Produce') },
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
      maxChunkBytes: 220,
      send: (msg: unknown) => watchApp.onMessage(msg),
    });

    watchApp = createWatchApp({
      document: ui.doc,
      fs,
      send: (msg: unknown) => void companion.onMessage(msg),
    });

    watchApp.start();
    await flushPromises();

    expect(ui.container.value).toBe(1);
    expect(ui.listsChecklist.value).toBe(0);
    expect(ui.status.text).toBe('Lists (2)');
    expect(ui.listsChecklist.visibleLists.map((r) => r.title)).toEqual(['Shopping', 'Hardware']);

    ui.listsChecklist.visibleLists[0].onclick!();
    await flushPromises();
    expect(ui.container.value).toBe(0);
    expect(ui.checklist.value).toBe(0); // 7 total rows < 8
    expect(ui.status.text).toBe('3 left');
    expect(ui.pageHint.text).toBe('Lists ›');
    expect(ui.checklist.visibleCategories).toEqual(['Produce', 'Dairy']);
    expect(ui.checklist.visibleTasks.map((t) => t.taskTitle)).toEqual(['Apples', 'Bananas', 'Milk']);

    expect(watchApp.goBack()).toBe(false);
    expect(ui.container.value).toBe(0);
    expect((fs.files.get('t-lists.cbor') as { activeCalendarHref?: string }).activeCalendarHref).toBe(
      '/remote.php/dav/calendars/alice/shopping/',
    );
    expect(fs.encodings.get('t-lists.cbor')).toBe('cbor');

    ui.container.swipeTo(1);
    expect(ui.container.value).toBe(1);
    expect(ui.status.text).toBe('Lists (2)');
    expect(ui.pageHint.text).toBe('‹ Tasks');
    expect(ui.listsChecklist.visibleLists[0].subtitle).toBe('3 left');
    expect(ui.listsChecklist.visibleLists[1].subtitle).toBe('Tap to load');

    expect(watchApp.goBack()).toBe(true);
    expect(ui.container.value).toBe(0);
    expect(ui.pageHint.text).toBe('Lists ›');
    expect(ui.checklist.visibleTasks[0].taskTitle).toBe('Apples');

    ui.container.swipeTo(1);
    ui.listsChecklist.visibleLists[1].onclick!();
    await flushPromises();
    expect(ui.container.value).toBe(0);
    expect(ui.status.text).toBe('1 left');
    expect(ui.checklist.visibleCategories).toEqual(['Fasteners']);
    expect(ui.checklist.visibleTasks[0].taskTitle).toBe('Wood Screws');
    expect((fs.files.get('t-lists.cbor') as { activeCalendarHref?: string }).activeCalendarHref).toBe(
      '/remote.php/dav/calendars/alice/hardware/',
    );

    const shoppingFile = getListCacheFilename('/remote.php/dav/calendars/alice/shopping/');
    const hardwareFile = getListCacheFilename('/remote.php/dav/calendars/alice/hardware/');
    expect(shoppingFile).toMatch(/^t-[0-9a-f]{8}\.cbor$/);
    expect(fs.files.has('t-lists.cbor')).toBe(true);
    expect(fs.files.has(shoppingFile)).toBe(true);
    expect(fs.files.has(hardwareFile)).toBe(true);
    expect(fs.encodings.get(shoppingFile)).toBe('cbor');
    expect(fs.encodings.get(hardwareFile)).toBe('cbor');
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
    ui1.listsChecklist.visibleLists[0].onclick!();
    await flushPromises();
    expect(ui1.status.text).toBe('2 left');
    expect(watchApp.goBack()).toBe(false);

    backend.setTask({
      uid: 'bread',
      calendarSlug: 'shopping',
      etag: 'e3',
      ics: makeIcs('bread', 'Bread', 'Bakery'),
    });

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

    expect(ui2.container.value).toBe(0);
    expect(ui2.checklist.value).toBe(0);
    expect(ui2.checklist.visibleTasks.map((t) => t.taskTitle)).toEqual(['Apples', 'Milk']);
    expect(sentTypes).toEqual([]);

    connected = true;
    watchApp.onConnectionChange(true);
    expect(sentTypes).toEqual(['FETCH_TASKS']);
    expect(ui2.status.text).toBe('Syncing...');
    expect(ui2.checklist.visibleTasks.map((t) => t.taskTitle)).toEqual(['Apples', 'Milk']);

    await flushPromises();
    while (deliveredReplies.length > 0) {
      deliveredReplies.shift()!();
    }
    expect(ui2.status.text).toBe('3 left');
    // Now 3 items + 3 categories + 2 header rows = 8 rows → starts scrolled past actions at value=2!
    expect(ui2.checklist.value).toBe(2);
    expect(ui2.checklist.visibleTasks.map((t) => t.taskTitle)).toContain('Bread');
  });

  it('uses static #tile-list (no virtual="1") inside #panoramaview with split Sync/Autohide buttons, category headers, and 28px fonts', () => {
    const gui = fsNode.readFileSync(path.resolve(__dirname, '../resources/index.gui'), 'utf8');
    const css = fsNode.readFileSync(path.resolve(__dirname, '../resources/styles.css'), 'utf8');
    const widgets = fsNode.readFileSync(path.resolve(__dirname, '../resources/widgets.gui'), 'utf8');

    expect(widgets).toContain('panoramaview_widget.gui');
    expect(gui).toContain('href="#panoramaview"');
    // Avoid VirtualTileList upward-scroll lockup bug on Versa 2
    expect(gui).not.toContain('id="virtual"');
    expect(gui).not.toContain('tile-list-pool');
    expect(gui).not.toContain('checkbox-tile');

    expect(gui).toContain('id="top-spacer-row"');
    expect(gui).toContain('id="actions-row"');
    expect(gui).toContain('id="sync-touch"');
    expect(gui).toContain('id="autohide-touch"');
    expect(gui).toContain('id="row-0"');
    expect(gui).toContain('id="row-59"');

    expect(gui).toMatch(/id="task-title"[^>]*font-size="28"/);
    expect(gui).toMatch(/id="list-title"[^>]*font-size="28"/);
    expect(gui).toMatch(/id="category-title"[^>]*font-size="18"/);
    expect(css).toMatch(/\.task-list-tile\s*\{[^}]*height:\s*52;/);
    expect(css).toMatch(/\.lists-list-tile\s*\{[^}]*height:\s*64;/);

    expect(gui).toMatch(/id="header-bg"[^>]*height="26"/);
    expect(gui.indexOf('id="header-bg"')).toBeGreaterThan(gui.indexOf('id="container"'));
  });

  it('toggles tasks instantaneously without sending Bluetooth traffic until pull-down Sync button is tapped and debounces fs writes', async () => {
    const backend = createMockCalDav({
      auth: { username: 'alice', password: 'secret' },
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
    let writeCount = 0;
    const trackedFs = {
      readFileSync: (name: string, encoding?: string) => fs.readFileSync(name, encoding),
      writeFileSync: (name: string, data: unknown, encoding?: string) => {
        writeCount += 1;
        fs.writeFileSync(name, data, encoding);
      },
    };
    const ui = createMockWatchDocument();
    const sentMessages: { type: string }[] = [];
    let watchApp: ReturnType<typeof createWatchApp>;
    const companion = createCompanionSync({
      settingsStorage,
      fetch: backend.createFetch(),
      send: (msg: unknown) => watchApp.onMessage(msg),
    });
    let clockMs = Date.parse('2026-05-01T10:05:00.000Z');
    watchApp = createWatchApp({
      document: ui.doc,
      fs: trackedFs,
      now: () => clockMs,
      persistDelayMs: 200,
      send: (msg: { type: string }) => {
        sentMessages.push(msg);
        void companion.onMessage(msg);
      },
    });

    watchApp.start();
    await flushPromises();
    expect(ui.status.text).toBe('2 left');

    sentMessages.length = 0;
    writeCount = 0;

    ui.checklist.visibleTasks[0].onclick!();
    clockMs += 1000;
    ui.checklist.visibleTasks[0].onclick!();
    clockMs += 1000;
    ui.checklist.visibleTasks[1].onclick!();

    expect(sentMessages).toEqual([]);
    expect(writeCount).toBe(0);
    expect(ui.checklist.visibleTasks[0].checked).toBe(false);
    expect(ui.checklist.visibleTasks[1].checked).toBe(true);
    expect(ui.status.text).toBe('2 unsynced');
    expect(watchApp.getState().pending).toEqual([
      { uid: 'apples', completed: false, updatedAt: Date.parse('2026-05-01T10:05:01.000Z') },
      { uid: 'milk', completed: true, updatedAt: Date.parse('2026-05-01T10:05:02.000Z') },
    ]);

    watchApp.flushPersistence();
    expect(writeCount).toBe(1);

    ui.checklist.value = 0;
    ui.syncTouch.onclick!();
    await flushPromises();
    expect(ui.status.text).toBe('1 left');
    expect(parseVTodo(backend.getTasks('shopping').find((t) => t.uid === 'milk')!.ics).status).toBe('COMPLETED');
    expect(parseVTodo(backend.getTasks('shopping').find((t) => t.uid === 'apples')!.ics).status).toBe('NEEDS-ACTION');
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

    ui.listsChecklist.visibleLists[0].onclick!();
    await flushPromises();
    expect(ui.checklist.visibleCategories).toEqual(['Produce', 'Dairy']);
    expect(ui.checklist.visibleTasks.map((t) => t.taskTitle)).toEqual(['Apples', 'Milk']);

    ui.container.swipeTo(1);
    ui.listsChecklist.visibleLists[1].onclick!();
    await flushPromises();
    expect(ui.checklist.visibleCategories).toEqual(['Electrical', 'Fasteners']);
    expect(ui.checklist.visibleTasks.map((t) => t.taskTitle)).toEqual(['Romex Wire', 'Wood Screws']);
  });

  it('immediately renders cached list on restart and reconciles: newer server edits win, newer watch toggles sync up', async () => {
    const tBase = Date.parse('2026-05-01T10:00:00.000Z');
    const tWatchOffline = Date.parse('2026-05-01T10:05:00.000Z');
    const tServerNewer = '20260501T101000Z';
    const tServerOlder = '20260501T100200Z';

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

    watchApp.start();
    await flushPromises();
    expect(ui1.status.text).toBe('2 left');

    connected = false;
    watchApp.onConnectionChange(false);
    clockMs = tWatchOffline;
    ui1.checklist.visibleTasks[0].onclick!();
    ui1.checklist.visibleTasks[1].onclick!();
    expect(ui1.status.text).toBe('Offline (2 pending)');

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

    expect(ui2.container.value).toBe(0);
    expect(ui2.checklist.visibleTasks[0].taskTitle).toBe('Apples');
    expect(ui2.checklist.visibleTasks[0].checked).toBe(true);
    expect(ui2.checklist.visibleTasks[1].taskTitle).toBe('Milk');
    expect(ui2.checklist.visibleTasks[1].checked).toBe(true);
    expect(ui2.status.text).toBe('Syncing...');

    for (let round = 0; round < 5; round++) {
      await flushPromises();
      while (deliveredReplies.length > 0) {
        deliveredReplies.shift()!();
      }
    }

    expect(ui2.status.text).toBe('1 left');
    expect(ui2.checklist.visibleTasks[0].taskTitle).toBe('Honeycrisp Apples');
    expect(ui2.checklist.visibleTasks[0].checked).toBe(true);
    expect(ui2.checklist.visibleTasks[1].taskTitle).toBe('Organic Milk');
    expect(ui2.checklist.visibleTasks[1].checked).toBe(false);

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

    backend.setTask({
      uid: 'milk',
      calendarSlug: 'shopping',
      etag: 'e2-newer',
      ics: makeIcs('milk', 'Milk', 'Dairy', {
        status: 'NEEDS-ACTION',
        lastModified: '20260501T101500Z',
      }),
    });

    ui.checklist.visibleTasks[0].onclick!();
    expect(ui.checklist.visibleTasks[0].checked).toBe(true);
    expect(ui.status.text).toBe('1 unsynced');
    watchApp.requestSync();
    await flushPromises();

    expect(ui.checklist.visibleTasks[0].checked).toBe(false);
    expect(ui.status.text).toBe('1 left');
    expect(parseVTodo(backend.getTasks('shopping')[0].ics).status).toBe('NEEDS-ACTION');

    const serverMilk2 = backend.getTasks('shopping')[0];
    backend.setTask({
      ...serverMilk2,
      etag: 'e3-even-newer',
      ics: makeIcs('milk', 'Milk', 'Dairy', {
        status: 'NEEDS-ACTION',
        lastModified: '20260501T102000Z',
      }),
    });
    await companion.onMessage({
      type: 'UPDATE_TASK',
      uid: 'milk',
      completed: true,
      calendarHref: '/remote.php/dav/calendars/alice/shopping/',
      updatedAt: Date.parse('2026-05-01T10:18:00.000Z'),
    });
    await flushPromises();
    expect(parseVTodo(backend.getTasks('shopping')[0].ics).status).toBe('NEEDS-ACTION');
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

  it('imports named fs functions directly in fitbit/app/index.js to avoid Rollup _interopNamespace on Versa 2', () => {
    const indexSrc = fsNode.readFileSync(path.resolve(__dirname, '../app/index.js'), 'utf8');
    expect(indexSrc).toMatch(/import\s*\{[^}]*\breadFileSync\b[^}]*\bwriteFileSync\b[^}]*\}\s*from\s*["']fs["']/);
    expect(indexSrc).not.toMatch(/import\s+\*\s+as\s+fs\s+from\s+["']fs["']/);
  });

  it('loads cached tasks from CBOR fs storage when completely offline without Bluetooth', () => {
    const shoppingHref = '/remote.php/dav/calendars/alice/shopping/';
    const fs = createMemoryFs();
    fs.writeFileSync(
      't-lists.cbor',
      {
        calendars: [{ href: shoppingHref, displayName: 'Shopping' }],
        activeCalendarHref: shoppingHref,
        categoryOrder: ['Produce', 'Dairy'],
      },
      'cbor',
    );
    fs.writeFileSync(
      getListCacheFilename(shoppingHref),
      {
        calendarHref: shoppingHref,
        tasks: [
          { uid: 'milk', summary: 'Milk', categories: ['Dairy'], completed: false },
          { uid: 'apples', summary: 'Apples', categories: ['Produce'], completed: true },
        ],
        pending: [],
        lastSyncedAt: Date.parse('2026-05-01T10:00:00.000Z'),
      },
      'cbor',
    );

    const ui = createMockWatchDocument();
    const sent: unknown[] = [];
    const watchApp = createWatchApp({
      document: ui.doc,
      fs,
      isConnected: () => false,
      send: (msg: unknown) => sent.push(msg),
    });

    watchApp.start();

    expect(sent).toEqual([]);
    expect(ui.container.value).toBe(0);
    expect(ui.checklist.value).toBe(0);
    expect(ui.status.text).toBe('Offline');
    expect(ui.checklist.visibleCategories).toEqual(['Produce', 'Dairy']);
    expect(ui.checklist.visibleTasks[0].taskTitle).toBe('Apples');
    expect(ui.checklist.visibleTasks[0].checked).toBe(true);
    expect(ui.checklist.visibleTasks[1].taskTitle).toBe('Milk');
    expect(ui.checklist.visibleTasks[1].checked).toBe(false);
  });
});
