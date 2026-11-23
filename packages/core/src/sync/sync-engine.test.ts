import { createMockCalDav } from '@tasker/mock-caldav';
import { describe, expect, it } from 'vitest';
import { createCalDavClient } from '../caldav/client.js';
import { parseVTodo, serializeVTodo } from '../caldav/vtodo.js';
import { InMemorySyncStorage } from './store.js';
import { SyncEngine } from './sync-engine.js';

const credentials = {
  baseUrl: 'https://cloud.example.com',
  username: 'alice',
  appPassword: 'secret',
};

const SHOPPING_HREF = '/remote.php/dav/calendars/alice/shopping/';

function makeIcs(uid: string, summary: string, lastModified: string, extra?: string): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VTODO',
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    'STATUS:NEEDS-ACTION',
    'CATEGORIES:Dairy',
    `LAST-MODIFIED:${lastModified}`,
  ];
  if (extra) lines.push(extra);
  lines.push('END:VTODO', 'END:VCALENDAR');
  return lines.join('\r\n');
}

describe('SyncEngine integration against @tasker/mock-caldav', () => {
  it('performs CTag-gated full sync, incremental pull, and server deletion pruning', async () => {
    const backend = createMockCalDav({
      auth: { username: 'alice', password: 'secret' },
      tasks: [
        {
          uid: 'milk',
          calendarSlug: 'shopping',
          etag: 'e1',
          ics: makeIcs('milk', 'Milk', '20260501T100000Z', 'X-OC-HIDESUBTASKS:0'),
        },
        {
          uid: 'eggs',
          calendarSlug: 'shopping',
          etag: 'e2',
          ics: makeIcs('eggs', 'Eggs', '20260501T100000Z'),
        },
      ],
    });
    const client = createCalDavClient(credentials, { fetch: backend.createFetch() });
    const storage = new InMemorySyncStorage();
    const engine = new SyncEngine(client, storage);

    // First sync pulls both tasks
    const first = await engine.fullSync(SHOPPING_HREF);
    expect(first.ctagChanged).toBe(true);
    expect(first.pulled).toBe(2);
    expect(first.pruned).toBe(0);
    expect(await storage.tasks.getTasksByCalendar(SHOPPING_HREF)).toHaveLength(2);

    // Second sync with unchanged CTag skips REPORT
    backend.clearRequests();
    const second = await engine.fullSync(SHOPPING_HREF);
    expect(second.ctagChanged).toBe(false);
    expect(second.pulled).toBe(0);
    expect(backend.requests.map((r) => r.method)).toEqual(['PROPFIND']);

    // Remote client deletes eggs and adds bread
    backend.deleteTask('shopping', 'eggs');
    backend.setTask({
      uid: 'bread',
      calendarSlug: 'shopping',
      ics: makeIcs('bread', 'Bread', '20260501T110000Z'),
    });

    const third = await engine.fullSync(SHOPPING_HREF);
    expect(third.ctagChanged).toBe(true);
    expect(third.pulled).toBe(1);
    expect(third.pruned).toBe(1);
    const localTasks = await storage.tasks.getTasksByCalendar(SHOPPING_HREF);
    expect(localTasks.map((t) => t.uid).sort()).toEqual(['bread', 'milk']);
  });

  it('queues offline create, update, toggle, and delete operations and flushes them cleanly', async () => {
    const backend = createMockCalDav({
      auth: { username: 'alice', password: 'secret' },
      tasks: [
        {
          uid: 'milk',
          calendarSlug: 'shopping',
          etag: 'e1',
          ics: makeIcs('milk', 'Milk', '20260501T100000Z', 'X-PRESERVE:yes'),
        },
      ],
    });
    const client = createCalDavClient(credentials, { fetch: backend.createFetch() });
    const storage = new InMemorySyncStorage();
    const engine = new SyncEngine(client, storage);

    await engine.fullSync(SHOPPING_HREF);

    // Offline mutations:
    // 1. Toggle existing task (preserves unknown X-PRESERVE property on PUT!)
    await engine.toggleTask('milk', true, new Date('2026-05-01T10:05:00.000Z'));
    // 2. Create a new task and edit it before syncing (coalesces into single create op)
    const created = await engine.createTask(
      SHOPPING_HREF,
      { uid: 'apples', summary: 'Apples', categories: ['Produce'] },
      new Date('2026-05-01T10:06:00.000Z'),
    );
    await engine.updateTask(
      { ...created, summary: 'Honeycrisp Apples' },
      new Date('2026-05-01T10:07:00.000Z'),
    );
    // 3. Create and delete an item while offline (cancels cleanly without hitting server)
    const temp = await engine.createTask(SHOPPING_HREF, { uid: 'temp', summary: 'Temp' });
    await engine.deleteTask(temp.uid);

    expect(await storage.queue.list()).toHaveLength(2);

    // Reconnect and sync
    const synced = await engine.fullSync(SHOPPING_HREF, {
      now: new Date('2026-05-01T10:10:00.000Z'),
    });
    expect(synced.flush.processed).toBe(2);
    expect(synced.flush.remaining).toBe(0);
    expect(synced.flush.conflicts).toEqual([]);

    // Verify server state
    const remoteTasks = backend.getTasks('shopping');
    expect(remoteTasks.map((t) => t.uid).sort()).toEqual(['apples', 'milk']);
    const remoteMilk = remoteTasks.find((t) => t.uid === 'milk')!;
    expect(remoteMilk.ics).toContain('STATUS:COMPLETED');
    expect(remoteMilk.ics).toContain('X-PRESERVE:yes');

    const remoteApples = parseVTodo(remoteTasks.find((t) => t.uid === 'apples')!.ics);
    expect(remoteApples.summary).toBe('Honeycrisp Apples');
    expect(remoteApples.categories).toEqual(['Produce']);

    // Delete synced task and flush
    await engine.deleteTask('apples');
    const afterDelete = await engine.flushQueue();
    expect(afterDelete.processed).toBe(1);
    expect(backend.getTasks('shopping').map((t) => t.uid)).toEqual(['milk']);
  });

  it('auto-resolves 412 conflicts using LAST-MODIFIED (both local-newer and server-newer)', async () => {
    const backend = createMockCalDav({
      auth: { username: 'alice', password: 'secret' },
      tasks: [
        {
          uid: 'milk',
          calendarSlug: 'shopping',
          etag: 'e1',
          ics: makeIcs('milk', 'Milk', '20260501T100000Z'),
        },
        {
          uid: 'bread',
          calendarSlug: 'shopping',
          etag: 'e2',
          ics: makeIcs('bread', 'Bread', '20260501T100000Z'),
        },
      ],
    });
    const client = createCalDavClient(credentials, { fetch: backend.createFetch() });
    const storage = new InMemorySyncStorage();
    const engine = new SyncEngine(client, storage);
    await engine.fullSync(SHOPPING_HREF);

    // Another device edits both tasks on the server
    backend.setTask({
      uid: 'milk',
      calendarSlug: 'shopping',
      etag: 'e1-remote',
      ics: makeIcs('milk', 'Remote Milk (older)', '20260501T100500Z'),
    });
    backend.setTask({
      uid: 'bread',
      calendarSlug: 'shopping',
      etag: 'e2-remote',
      ics: makeIcs('bread', 'Remote Sourdough (newer)', '20260501T102000Z'),
    });

    // Local device edits milk AFTER remote (10:10 > 10:05 → local wins)
    // and edits bread BEFORE remote (10:10 < 10:20 → server wins)
    const milk = (await storage.tasks.getTask('milk'))!;
    const bread = (await storage.tasks.getTask('bread'))!;
    await engine.updateTask({ ...milk, summary: 'Local Milk (newer)' }, new Date('2026-05-01T10:10:00.000Z'));
    await engine.updateTask({ ...bread, summary: 'Local Bread (older)' }, new Date('2026-05-01T10:10:00.000Z'));

    const result = await engine.flushQueue({ conflictStrategy: 'auto' });
    expect(result.processed).toBe(2);
    expect(result.remaining).toBe(0);
    expect(result.conflicts).toEqual([]);

    const finalMilk = await storage.tasks.getTask('milk');
    const finalBread = await storage.tasks.getTask('bread');
    expect(finalMilk?.summary).toBe('Local Milk (newer)');
    expect(finalMilk?.dirty).toBe(false);
    expect(finalBread?.summary).toBe('Remote Sourdough (newer)');
    expect(finalBread?.dirty).toBe(false);

    // Server also reflects local winner for milk
    const serverMilk = parseVTodo(backend.getTasks('shopping').find((t) => t.uid === 'milk')!.ics);
    expect(serverMilk.summary).toBe('Local Milk (newer)');
  });

  it('surfaces 412 conflicts in manual mode and applies explicit user choice', async () => {
    const initialIcs = serializeVTodo(
      { uid: 'cheese', summary: 'Cheddar', status: 'NEEDS-ACTION', categories: ['Dairy'] },
      { now: new Date('2026-05-01T10:00:00.000Z') },
    );
    const backend = createMockCalDav({
      auth: { username: 'alice', password: 'secret' },
      tasks: [{ uid: 'cheese', calendarSlug: 'shopping', etag: 'e1', ics: initialIcs }],
    });
    const client = createCalDavClient(credentials, { fetch: backend.createFetch() });
    const storage = new InMemorySyncStorage();
    const engine = new SyncEngine(client, storage);
    await engine.fullSync(SHOPPING_HREF);

    // Remote change
    backend.setTask({
      uid: 'cheese',
      calendarSlug: 'shopping',
      etag: 'e2',
      ics: makeIcs('cheese', 'Gouda', '20260501T100500Z'),
    });

    // Local change
    const localCheese = (await storage.tasks.getTask('cheese'))!;
    await engine.updateTask({ ...localCheese, summary: 'Brie' }, new Date('2026-05-01T10:02:00.000Z'));

    const flush = await engine.flushQueue({ conflictStrategy: 'manual' });
    expect(flush.conflicts).toHaveLength(1);
    expect(flush.remaining).toBe(1);
    expect(flush.conflicts[0].local.summary).toBe('Brie');
    expect(flush.conflicts[0].server.summary).toBe('Gouda');

    // User chooses local version despite server having newer timestamp
    await engine.resolveManualConflict(flush.conflicts[0], 'local');
    expect(await storage.queue.list()).toHaveLength(0);
    expect((await storage.tasks.getTask('cheese'))?.summary).toBe('Brie');
    const serverCheese = parseVTodo(backend.getTasks('shopping')[0].ics);
    expect(serverCheese.summary).toBe('Brie');
  });
});
