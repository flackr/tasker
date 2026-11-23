import { parseVTodo } from '@tasker/core';
import { createMockCalDav } from '@tasker/mock-caldav';
import { describe, expect, it } from 'vitest';
import { createWatchApp } from '../app/watch-app.js';
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
    readFileSync: (name: string) => {
      if (!files.has(name)) throw new Error('ENOENT');
      return JSON.parse(JSON.stringify(files.get(name)));
    },
    writeFileSync: (name: string, data: unknown) => {
      files.set(name, JSON.parse(JSON.stringify(data)));
    },
  };
}

interface MockTile {
  display: string;
  checkbox: { text: string; value: number; onclick: (() => void) | null };
  aisle: { text: string };
}

function createMockWatchDocument(slotCount = 20) {
  const status = { text: '' };
  const syncBtn = { onclick: null as (() => void) | null };
  const tiles: MockTile[] = [];

  for (let i = 0; i < slotCount; i++) {
    tiles.push({
      display: 'none',
      checkbox: { text: '', value: 0, onclick: null },
      aisle: { text: '' },
    });
  }

  const doc = {
    getElementById(id: string) {
      if (id === 'status') return status;
      if (id === 'sync-btn') return syncBtn;
      const match = /^item-(\d+)$/.exec(id);
      if (match) {
        const idx = Number(match[1]);
        if (idx >= tiles.length) return null;
        const tile = tiles[idx];
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
            if (subId === 'item-aisle') return tile.aisle;
            return null;
          },
        };
      }
      return null;
    },
  };

  return { doc, status, syncBtn, tiles };
}

function makeIcs(uid: string, summary: string, categories: string, extra?: string): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTODO',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    `CATEGORIES:${categories}`,
    'STATUS:NEEDS-ACTION',
    'LAST-MODIFIED:20260501T100000Z',
  ];
  if (extra) lines.push(extra);
  lines.push('END:VTODO', 'END:VCALENDAR');
  return lines.join('\r\n');
}

async function flushPromises(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('Fitbit Watch + Companion + MockCalDav end-to-end logic', () => {
  it('syncs chunked tasks sorted by aisle, toggles losslessly, and survives offline restarts', async () => {
    const backend = createMockCalDav({
      auth: { username: 'alice', password: 'secret' },
      tasks: [
        { uid: 'milk', calendarSlug: 'shopping', etag: 'e1', ics: makeIcs('milk', 'Milk', 'Dairy', 'X-OC-HIDESUBTASKS:0') },
        { uid: 'apples', calendarSlug: 'shopping', etag: 'e2', ics: makeIcs('apples', 'Apples', 'Produce') },
        { uid: 'bread', calendarSlug: 'shopping', etag: 'e3', ics: makeIcs('bread', 'Sourdough', 'Bakery') },
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
    });

    const settingsStorage = createMemorySettings({
      app_server: JSON.stringify({ name: 'https://cloud.example.com' }),
      app_username: JSON.stringify({ name: 'alice' }),
      app_password: JSON.stringify({ name: 'secret' }),
      app_config_path: JSON.stringify({ name: 'Notes/tasker-config.json' }),
    });

    const fs = createMemoryFs();
    const { doc, status, tiles } = createMockWatchDocument();
    let connected = true;
    const companionReceived: unknown[] = [];
    const watchReceived: unknown[] = [];

    let watchApp: ReturnType<typeof createWatchApp>;
    const companion = createCompanionSync({
      settingsStorage,
      fetch: backend.createFetch(),
      maxChunkBytes: 220, // Force chunked TASKS_CHUNK transfer!
      send: (msg: unknown) => {
        watchReceived.push(msg);
        if (connected) {
          watchApp.onMessage(msg);
        }
      },
    });

    watchApp = createWatchApp({
      document: doc,
      fs,
      isConnected: () => connected,
      send: (msg: unknown) => {
        companionReceived.push(msg);
        if (connected) {
          void companion.onMessage(msg);
        }
      },
    });

    watchApp.start();
    await flushPromises();

    // Verify chunked messages were used and reassembled in aisle walk order
    expect(watchReceived.some((m) => (m as { type: string }).type === 'TASKS_CHUNK')).toBe(true);
    expect(status.text).toBe('3 left');
    expect(tiles[0].checkbox.text).toBe('Apples');
    expect(tiles[0].aisle.text).toBe('Produce');
    expect(tiles[1].checkbox.text).toBe('Sourdough');
    expect(tiles[2].checkbox.text).toBe('Milk');
    expect(tiles[3].display).toBe('none');

    // Tap Milk (index 2) online → lossless PUT preserving X-OC-HIDESUBTASKS
    tiles[2].checkbox.onclick!();
    await flushPromises();
    expect(status.text).toBe('2 left');
    const serverMilk = backend.getTasks('shopping').find((t) => t.uid === 'milk')!;
    expect(serverMilk.ics).toContain('STATUS:COMPLETED');
    expect(serverMilk.ics).toContain('X-OC-HIDESUBTASKS:0');

    // Go offline, tap Apples, then simulate watch app restart from File Storage cache
    connected = false;
    watchApp.onConnectionChange(false);
    tiles[0].checkbox.onclick!();
    expect(status.text).toBe('Offline (1 pending)');

    // Restart watch app with fresh DOM but same fs cache while still offline
    const restartedDom = createMockWatchDocument();
    watchApp = createWatchApp({
      document: restartedDom.doc,
      fs,
      isConnected: () => connected,
      send: (msg: unknown) => {
        if (connected) {
          void companion.onMessage(msg);
        }
      },
    });
    watchApp.start();
    expect(restartedDom.status.text).toBe('Offline (1 pending)');
    expect(restartedDom.tiles[0].checkbox.text).toBe('Apples');
    expect(restartedDom.tiles[0].checkbox.value).toBe(1);

    // Server concurrently edits Apples summary (triggers 412 on Companion PUT → auto-refresh + lossless retry!)
    backend.setTask({
      uid: 'apples',
      calendarSlug: 'shopping',
      etag: 'etag-concurrent-edit',
      ics: makeIcs('apples', 'Honeycrisp Apples', 'Produce', 'X-REMOTE-TAG:kept'),
    });

    // Reconnect Bluetooth → pending toggle replays and reconciles
    connected = true;
    watchApp.onConnectionChange(true);
    await flushPromises();

    expect(restartedDom.status.text).toBe('1 left');
    const finalApples = parseVTodo(backend.getTasks('shopping').find((t) => t.uid === 'apples')!.ics);
    expect(finalApples.status).toBe('COMPLETED');
    expect(finalApples.summary).toBe('Honeycrisp Apples');
    expect(finalApples.rawIcs).toContain('X-REMOTE-TAG:kept');
  });

  it('surfaces clear error message when credentials are missing', async () => {
    const fs = createMemoryFs();
    const { doc, status } = createMockWatchDocument();
    let watchApp: ReturnType<typeof createWatchApp>;
    const companion = createCompanionSync({
      settingsStorage: createMemorySettings(),
      send: (msg: unknown) => watchApp.onMessage(msg),
    });
    watchApp = createWatchApp({
      document: doc,
      fs,
      send: (msg: unknown) => void companion.onMessage(msg),
    });

    watchApp.start();
    await flushPromises();
    expect(status.text).toContain('Err:');
    expect(status.text).toContain('credentials');
  });
});
