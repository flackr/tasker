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

interface MockSpacerRow {
  kind: 'spacer';
  listName: string;
}

interface MockActionsRow {
  kind: 'actions';
  syncLabel: string;
  syncOnclick: (() => void) | null;
  autohideLabel: string;
  autohideFill: string;
  autohideOnclick: (() => void) | null;
}

interface MockListsSyncRow {
  kind: 'lists-sync';
  label: string;
  onclick: (() => void) | null;
}

interface MockCategoryRow {
  kind: 'category';
  title: string;
}

interface MockTaskRow {
  kind: 'task';
  taskIndex: number;
  title: string;
  titleFill: string;
  checked: boolean;
  onclick: (() => void) | null;
}

interface MockListRow {
  kind: 'list';
  listIndex: number;
  title: string;
  subtitle: string;
  onclick: (() => void) | null;
}

type MockRenderedRow =
  | MockSpacerRow
  | MockActionsRow
  | MockListsSyncRow
  | MockCategoryRow
  | MockTaskRow
  | MockListRow;

interface MockVirtualDelegate {
  getTileInfo(index: number): {
    type: string;
    category?: string;
    taskIndex?: number;
    listIndex?: number;
  };
  configureTile(tile: unknown, info: unknown): void;
}

function createMockVirtualTileList() {
  let delegate: MockVirtualDelegate | null = null;
  let length = 0;
  let value = 0;
  let rows: MockRenderedRow[] = [];

  function rebuild() {
    rows = [];
    if (!delegate) return;
    for (let i = 0; i < length; i++) {
      const info = delegate.getTileInfo(i);
      if (info.type === 'spacer-pool') {
        const row: MockSpacerRow = { kind: 'spacer', listName: '' };
        const tile = {
          getElementById(id: string) {
            if (id === 'active-list-label') {
              return {
                get text() { return row.listName; },
                set text(v: string) { row.listName = v; },
              };
            }
            return null;
          },
        };
        delegate.configureTile(tile, info);
        rows.push(row);
      } else if (info.type === 'actions-pool') {
        const row: MockActionsRow = {
          kind: 'actions',
          syncLabel: '',
          syncOnclick: null,
          autohideLabel: '',
          autohideFill: '',
          autohideOnclick: null,
        };
        const tile = {
          getElementById(id: string) {
            if (id === 'sync-label') {
              return {
                get text() { return row.syncLabel; },
                set text(v: string) { row.syncLabel = v; },
              };
            }
            if (id === 'sync-touch') {
              return {
                get onclick() { return row.syncOnclick; },
                set onclick(fn: (() => void) | null) { row.syncOnclick = fn; },
              };
            }
            if (id === 'autohide-label') {
              return {
                get text() { return row.autohideLabel; },
                set text(v: string) { row.autohideLabel = v; },
              };
            }
            if (id === 'autohide-touch') {
              return {
                style: {
                  get fill() { return row.autohideFill; },
                  set fill(v: string) { row.autohideFill = v; },
                },
                get onclick() { return row.autohideOnclick; },
                set onclick(fn: (() => void) | null) { row.autohideOnclick = fn; },
              };
            }
            return null;
          },
        };
        delegate.configureTile(tile, info);
        rows.push(row);
      } else if (info.type === 'lists-sync-pool') {
        const row: MockListsSyncRow = { kind: 'lists-sync', label: '', onclick: null };
        const tile = {
          getElementById(id: string) {
            if (id === 'lists-sync-label') {
              return {
                get text() { return row.label; },
                set text(v: string) { row.label = v; },
              };
            }
            if (id === 'lists-sync-touch') {
              return {
                get onclick() { return row.onclick; },
                set onclick(fn: (() => void) | null) { row.onclick = fn; },
              };
            }
            return null;
          },
        };
        delegate.configureTile(tile, info);
        rows.push(row);
      } else if (info.type === 'category-pool') {
        const row: MockCategoryRow = { kind: 'category', title: '' };
        const tile = {
          getElementById(id: string) {
            if (id === 'category-title') {
              return {
                get text() { return row.title; },
                set text(v: string) { row.title = v; },
              };
            }
            return null;
          },
        };
        delegate.configureTile(tile, info);
        rows.push(row);
      } else if (info.type === 'item-pool') {
        const row: MockTaskRow = {
          kind: 'task',
          taskIndex: info.taskIndex ?? 0,
          title: '',
          titleFill: '#ffffff',
          checked: false,
          onclick: null,
        };
        const tile = {
          getElementById(id: string) {
            if (id === 'task-title') {
              return {
                get text() { return row.title; },
                set text(v: string) { row.title = v; },
                style: {
                  get fill() { return row.titleFill; },
                  set fill(v: string) { row.titleFill = v; },
                },
              };
            }
            if (id === 'checkbox-check') {
              return {
                style: {
                  get display() { return row.checked ? 'inline' : 'none'; },
                  set display(v: string) { row.checked = v !== 'none'; },
                },
              };
            }
            if (id === 'task-touch') {
              return {
                get onclick() { return row.onclick; },
                set onclick(fn: (() => void) | null) { row.onclick = fn; },
              };
            }
            return null;
          },
        };
        delegate.configureTile(tile, info);
        rows.push(row);
      } else if (info.type === 'list-pool') {
        const row: MockListRow = {
          kind: 'list',
          listIndex: info.listIndex ?? 0,
          title: '',
          subtitle: '',
          onclick: null,
        };
        const tile = {
          getElementById(id: string) {
            if (id === 'list-title') {
              return {
                get text() { return row.title; },
                set text(v: string) { row.title = v; },
              };
            }
            if (id === 'list-subtitle') {
              return {
                get text() { return row.subtitle; },
                set text(v: string) { row.subtitle = v; },
              };
            }
            if (id === 'list-touch') {
              return {
                get onclick() { return row.onclick; },
                set onclick(fn: (() => void) | null) { row.onclick = fn; },
              };
            }
            return null;
          },
        };
        delegate.configureTile(tile, info);
        rows.push(row);
      }
    }
  }

  return {
    get delegate() { return delegate; },
    set delegate(d: MockVirtualDelegate | null) { delegate = d; },
    get length() { return length; },
    set length(n: number) { length = n; rebuild(); },
    get value() { return value; },
    set value(v: number) { value = v; },
    get rows() { return rows; },
    get taskRows(): MockTaskRow[] {
      return rows.filter((r): r is MockTaskRow => r.kind === 'task');
    },
    get categoryRows(): MockCategoryRow[] {
      return rows.filter((r): r is MockCategoryRow => r.kind === 'category');
    },
    get listRows(): MockListRow[] {
      return rows.filter((r): r is MockListRow => r.kind === 'list');
    },
    get actionsRow(): MockActionsRow | undefined {
      return rows.find((r): r is MockActionsRow => r.kind === 'actions');
    },
  };
}

function createMockWatchDocument() {
  const status = { text: '' };
  const pageHint = { text: '' };
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

  const checklist = createMockVirtualTileList();
  const listsChecklist = createMockVirtualTileList();

  const doc = {
    getElementById(id: string) {
      if (id === 'status') return status;
      if (id === 'page-hint') return pageHint;
      if (id === 'container') return container;
      if (id === 'checklist') return checklist;
      if (id === 'lists-checklist') return listsChecklist;
      return null;
    },
  };

  return { doc, status, pageHint, container, checklist, listsChecklist };
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

describe('Fitbit Watch panorama navigation, uniform virtual tile list, autohide, local fs persistence, and reconciliation', () => {
  it('groups consecutive tasks under single category header rows after row 0 spacer and row 1 actions, and filters completed items in Autohide mode', () => {
    const items = [
      { uid: '1', summary: 'Apples', categories: ['Produce'], completed: false },
      { uid: '2', summary: 'Bananas', categories: ['Produce'], completed: true },
      { uid: '3', summary: 'Milk', categories: ['Dairy'], completed: true },
      { uid: '4', summary: 'Napkins', categories: [], completed: false },
    ];

    expect(buildTaskRows(items)).toEqual([
      { type: 'spacer-pool' },
      { type: 'actions-pool' },
      { type: 'category-pool', category: 'Produce' },
      { type: 'item-pool', taskIndex: 0 },
      { type: 'item-pool', taskIndex: 1 },
      { type: 'category-pool', category: 'Dairy' },
      { type: 'item-pool', taskIndex: 2 },
      { type: 'category-pool', category: 'Uncategorized' },
      { type: 'item-pool', taskIndex: 3 },
    ]);

    // With hideCompleted=true: Bananas, Milk, and the now-empty Dairy category header are omitted!
    expect(buildTaskRows(items, { hideCompleted: true })).toEqual([
      { type: 'spacer-pool' },
      { type: 'actions-pool' },
      { type: 'category-pool', category: 'Produce' },
      { type: 'item-pool', taskIndex: 0 },
      { type: 'category-pool', category: 'Uncategorized' },
      { type: 'item-pool', taskIndex: 3 },
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

    // Default: Show All (button reads "Autohide" to enable hiding)
    expect(ui.checklist.actionsRow!.autohideLabel).toBe('Autohide');
    expect(ui.checklist.categoryRows.map((c) => c.title)).toEqual(['Produce', 'Dairy']);
    expect(ui.checklist.taskRows.map((t) => t.title)).toEqual(['Apples', 'Cheese', 'Milk']);

    // Tap Autohide → hides completed Apples + empty Produce category, button switches to "Show All"
    ui.checklist.actionsRow!.autohideOnclick!();
    expect(watchApp.getState().hideCompleted).toBe(true);
    expect(ui.checklist.actionsRow!.autohideLabel).toBe('Show All');
    expect(ui.checklist.categoryRows.map((c) => c.title)).toEqual(['Dairy']);
    expect(ui.checklist.taskRows.map((t) => t.title)).toEqual(['Cheese', 'Milk']);
    expect((fs.files.get('t-lists.cbor') as { hideCompleted?: boolean }).hideCompleted).toBe(true);

    // Tap Cheese while Autohide is active → Cheese immediately disappears, Milk remains
    ui.checklist.taskRows[0].onclick!();
    expect(ui.checklist.taskRows.map((t) => t.title)).toEqual(['Milk']);

    // Tap Milk → all items checked, list scrolls to value=0 so Sync & Show All are immediately reachable
    ui.checklist.taskRows[0].onclick!();
    expect(ui.checklist.taskRows).toEqual([]);
    expect(ui.checklist.value).toBe(0);

    // Relaunch offline → hideCompleted preference restored from t-lists.cbor
    const ui2 = createMockWatchDocument();
    const watchApp2 = createWatchApp({
      document: ui2.doc,
      fs,
      isConnected: () => false,
      send: () => {},
    });
    watchApp2.start();
    expect(watchApp2.getState().hideCompleted).toBe(true);
    expect(ui2.checklist.actionsRow!.autohideLabel).toBe('Show All');
    expect(ui2.checklist.taskRows).toEqual([]);

    // Tap Show All → all 3 items reappear!
    ui2.checklist.actionsRow!.autohideOnclick!();
    expect(watchApp2.getState().hideCompleted).toBe(false);
    expect(ui2.checklist.actionsRow!.autohideLabel).toBe('Autohide');
    expect(ui2.checklist.taskRows.map((t) => t.title)).toEqual(['Apples', 'Cheese', 'Milk']);
  });

  it('supports swiping to Lists via #panoramaview, going back, pull-down Sync tile, and independent CBOR fs caches', async () => {
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

    // Multiple VTODO lists available → panorama lands on Lists page (1)
    expect(ui.container.value).toBe(1);
    expect(ui.listsChecklist.value).toBe(0);
    expect(ui.status.text).toBe('Lists (2)');
    expect(ui.listsChecklist.listRows.map((r) => r.title)).toEqual(['Shopping', 'Hardware']);

    // Select Shopping (3 items + 2 categories = 7 rows < 8 → starts at value=0 so nothing clips;
    // lists with >= 8 rows start scrolled past rows 0-1 at value=2)
    ui.listsChecklist.listRows[0].onclick!();
    await flushPromises();
    expect(ui.container.value).toBe(0);
    expect(ui.checklist.value).toBe(0);
    expect(ui.status.text).toBe('3 left');
    expect(ui.pageHint.text).toBe('Lists ›');
    expect(ui.checklist.categoryRows.map((c) => c.title)).toEqual(['Produce', 'Dairy']);
    expect(ui.checklist.taskRows.map((t) => t.title)).toEqual(['Apples', 'Bananas', 'Milk']);

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
    expect(ui.listsChecklist.listRows[0].subtitle).toBe('3 left');
    expect(ui.listsChecklist.listRows[1].subtitle).toBe('Tap to load');

    expect(watchApp.goBack()).toBe(true);
    expect(ui.container.value).toBe(0);
    expect(ui.pageHint.text).toBe('Lists ›');
    expect(ui.checklist.taskRows[0].title).toBe('Apples');

    ui.container.swipeTo(1);
    ui.listsChecklist.listRows[1].onclick!();
    await flushPromises();
    expect(ui.container.value).toBe(0);
    expect(ui.status.text).toBe('1 left');
    expect(ui.checklist.categoryRows.map((c) => c.title)).toEqual(['Fasteners']);
    expect(ui.checklist.taskRows[0].title).toBe('Wood Screws');
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
    ui1.listsChecklist.listRows[0].onclick!();
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
    expect(ui2.checklist.taskRows.map((t) => t.title)).toEqual(['Apples', 'Milk']);
    expect(sentTypes).toEqual([]);

    connected = true;
    watchApp.onConnectionChange(true);
    expect(sentTypes).toEqual(['FETCH_TASKS']);
    expect(ui2.status.text).toBe('Syncing...');
    expect(ui2.checklist.taskRows.map((t) => t.title)).toEqual(['Apples', 'Milk']);

    await flushPromises();
    while (deliveredReplies.length > 0) {
      deliveredReplies.shift()!();
    }
    expect(ui2.status.text).toBe('3 left');
    expect(ui2.checklist.taskRows.map((t) => t.title)).toContain('Bread');
  });

  it('enforces uniform tile heights across all VirtualTileList pools to prevent Fitbit OS 4 scroll drift, plus split Sync/Autohide buttons and 28px fonts', () => {
    const gui = fsNode.readFileSync(path.resolve(__dirname, '../resources/index.gui'), 'utf8');
    const css = fsNode.readFileSync(path.resolve(__dirname, '../resources/styles.css'), 'utf8');
    const widgets = fsNode.readFileSync(path.resolve(__dirname, '../resources/widgets.gui'), 'utf8');

    expect(widgets).toContain('panoramaview_widget.gui');
    expect(gui).toContain('href="#panoramaview"');
    expect(gui).toContain('<var id="virtual" value="1" />');
    expect(gui).toContain('id="actions-pool"');
    expect(gui).toContain('id="sync-touch"');
    expect(gui).toContain('id="autohide-touch"');
    expect(gui).toContain('id="category-pool"');
    expect(gui).toContain('id="item-pool"');
    expect(gui).not.toContain('checkbox-tile');

    // Verify ALL 4 Tasks VirtualTileList symbols have the EXACT same explicit height="52"
    for (const symId of ['top-spacer', 'actions-tile', 'category-header', 'task-item']) {
      expect(gui).toMatch(new RegExp(`<symbol\\s+id="${symId}"[^>]*class="task-list-tile"[^>]*height="52"`));
    }
    // Verify ALL 2 Lists VirtualTileList symbols have the EXACT same explicit height="64"
    for (const symId of ['lists-sync-tile', 'list-item']) {
      expect(gui).toMatch(new RegExp(`<symbol\\s+id="${symId}"[^>]*class="lists-list-tile"[^>]*height="64"`));
    }

    expect(gui).toMatch(/id="task-title"[^>]*font-size="28"/);
    expect(gui).toMatch(/id="list-title"[^>]*font-size="28"/);
    expect(gui).toMatch(/id="category-title"[^>]*font-size="18"/);
    expect(css).toMatch(/\.task-list-tile\s*\{[^}]*height:\s*52;/);
    expect(css).toMatch(/\.lists-list-tile\s*\{[^}]*height:\s*64;/);

    // Slim 28px header bar declared AFTER panorama so it always paints on top
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
    expect(ui.checklist.value).toBe(0);

    sentMessages.length = 0;
    writeCount = 0;

    ui.checklist.taskRows[0].onclick!();
    clockMs += 1000;
    ui.checklist.taskRows[0].onclick!();
    clockMs += 1000;
    ui.checklist.taskRows[1].onclick!();

    expect(sentMessages).toEqual([]);
    expect(writeCount).toBe(0);
    expect(ui.checklist.taskRows[0].checked).toBe(false);
    expect(ui.checklist.taskRows[1].checked).toBe(true);
    expect(ui.status.text).toBe('2 unsynced');
    expect(watchApp.getState().pending).toEqual([
      { uid: 'apples', completed: false, updatedAt: Date.parse('2026-05-01T10:05:01.000Z') },
      { uid: 'milk', completed: true, updatedAt: Date.parse('2026-05-01T10:05:02.000Z') },
    ]);

    watchApp.flushPersistence();
    expect(writeCount).toBe(1);

    // Pull down to row 0 and tap Sync button → pushes toggles and resets scroll cleanly
    ui.checklist.value = 0;
    ui.checklist.actionsRow!.syncOnclick!();
    await flushPromises();
    expect(ui.status.text).toBe('1 left');
    expect(ui.checklist.value).toBe(0);
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

    ui.listsChecklist.listRows[0].onclick!();
    await flushPromises();
    expect(ui.checklist.categoryRows.map((c) => c.title)).toEqual(['Produce', 'Dairy']);
    expect(ui.checklist.taskRows.map((t) => t.title)).toEqual(['Apples', 'Milk']);

    ui.container.swipeTo(1);
    ui.listsChecklist.listRows[1].onclick!();
    await flushPromises();
    expect(ui.checklist.categoryRows.map((c) => c.title)).toEqual(['Electrical', 'Fasteners']);
    expect(ui.checklist.taskRows.map((t) => t.title)).toEqual(['Romex Wire', 'Wood Screws']);
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
    ui1.checklist.taskRows[0].onclick!();
    ui1.checklist.taskRows[1].onclick!();
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
    expect(ui2.checklist.taskRows[0].title).toBe('Apples');
    expect(ui2.checklist.taskRows[0].checked).toBe(true);
    expect(ui2.checklist.taskRows[1].title).toBe('Milk');
    expect(ui2.checklist.taskRows[1].checked).toBe(true);
    expect(ui2.status.text).toBe('Syncing...');

    for (let round = 0; round < 5; round++) {
      await flushPromises();
      while (deliveredReplies.length > 0) {
        deliveredReplies.shift()!();
      }
    }

    expect(ui2.status.text).toBe('1 left');
    expect(ui2.checklist.taskRows[0].title).toBe('Honeycrisp Apples');
    expect(ui2.checklist.taskRows[0].checked).toBe(true);
    expect(ui2.checklist.taskRows[1].title).toBe('Organic Milk');
    expect(ui2.checklist.taskRows[1].checked).toBe(false);

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

    ui.checklist.taskRows[0].onclick!();
    expect(ui.checklist.taskRows[0].checked).toBe(true);
    expect(ui.status.text).toBe('1 unsynced');
    watchApp.requestSync();
    await flushPromises();

    expect(ui.checklist.taskRows[0].checked).toBe(false);
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
    expect(ui.checklist.categoryRows.map((c) => c.title)).toEqual(['Produce', 'Dairy']);
    expect(ui.checklist.taskRows[0].title).toBe('Apples');
    expect(ui.checklist.taskRows[0].checked).toBe(true);
    expect(ui.checklist.taskRows[1].title).toBe('Milk');
    expect(ui.checklist.taskRows[1].checked).toBe(false);
  });
});
