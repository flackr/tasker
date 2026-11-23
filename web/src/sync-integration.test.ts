import { createCalDavClient, SyncEngine } from '@tasker/core';
import { createMockCalDav } from '@tasker/mock-caldav';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearAllLocalData, IndexedDbSyncStorage } from './db/storage';

const credentials = {
  baseUrl: 'https://cloud.example.com',
  username: 'alice',
  appPassword: 'secret',
};

const SHOPPING_HREF = '/remote.php/dav/calendars/alice/shopping/';

const MILK_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VTODO',
  'UID:milk',
  'SUMMARY:Milk',
  'CATEGORIES:Dairy',
  'STATUS:NEEDS-ACTION',
  'LAST-MODIFIED:20260501T100000Z',
  'END:VTODO',
  'END:VCALENDAR',
].join('\r\n');

describe('PWA SyncEngine + IndexedDB + MockCalDav integration', () => {
  const storage = new IndexedDbSyncStorage();

  beforeEach(async () => {
    await clearAllLocalData();
  });

  it('syncs tasks into IndexedDB, replays offline mutations, and resolves manual 412 conflicts', async () => {
    const backend = createMockCalDav({
      auth: { username: 'alice', password: 'secret' },
      tasks: [{ uid: 'milk', calendarSlug: 'shopping', etag: 'e1', ics: MILK_ICS }],
    });
    const client = createCalDavClient(credentials, { fetch: backend.createFetch() });
    const engine = new SyncEngine(client, storage);

    await engine.fullSync(SHOPPING_HREF);
    expect((await storage.tasks.getTasksByCalendar(SHOPPING_HREF)).map((t) => t.summary)).toEqual([
      'Milk',
    ]);

    // Queue an offline create + toggle
    await engine.createTask(SHOPPING_HREF, {
      uid: 'apples',
      summary: 'Apples',
      categories: ['Produce'],
    });
    await engine.toggleTask('milk', true);
    expect(await storage.queue.list()).toHaveLength(2);

    // Concurrent remote edit on milk causes a 412 when flushing in manual mode
    backend.setTask({
      uid: 'milk',
      calendarSlug: 'shopping',
      etag: 'e2-remote',
      ics: MILK_ICS.replace('SUMMARY:Milk', 'SUMMARY:Whole Milk'),
    });

    const flush = await engine.flushQueue({ conflictStrategy: 'manual' });
    expect(flush.processed).toBe(1); // apples created
    expect(flush.conflicts).toHaveLength(1);
    expect(flush.conflicts[0].uid).toBe('milk');

    // Resolve choosing local toggle
    await engine.resolveManualConflict(flush.conflicts[0], 'local');
    expect(await storage.queue.list()).toHaveLength(0);
    expect((await storage.tasks.getTask('milk'))?.status).toBe('COMPLETED');
    expect(backend.getTasks('shopping')).toHaveLength(2);
  });
});
