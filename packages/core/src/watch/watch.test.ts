import { describe, expect, it } from 'vitest';
import {
  acknowledgeWatchToggle,
  applyOptimisticToggle,
  mergeWatchTasks,
  reconcileWatchTasks,
} from './state.js';
import {
  chunkTasksPayload,
  createChunkReassembler,
  utf8ByteLength,
} from './protocol.js';
import type { CompactTask, CompanionToWatchMessage } from './types.js';

describe('watch state merge, optimistic toggles, and timestamp reconciliation', () => {
  const baseTasks: CompactTask[] = [
    { uid: '1', summary: 'Milk', categories: ['Dairy'], completed: false, etag: 'e1', lastModified: 500 },
    { uid: '2', summary: 'Bread', categories: ['Bakery'], completed: false, etag: 'e2', lastModified: 500 },
  ];

  it('applies optimistic toggles and deduplicates repeated toggles for the same uid', () => {
    const step1 = applyOptimisticToggle(baseTasks, [], '1', true, 1000);
    expect(step1.tasks[0].completed).toBe(true);
    expect(step1.tasks[0].lastModified).toBe(1000);
    expect(step1.pending).toEqual([{ uid: '1', completed: true, updatedAt: 1000 }]);

    // Toggling back updates the existing pending entry rather than adding a duplicate
    const step2 = applyOptimisticToggle(step1.tasks, step1.pending, '1', false, 2000);
    expect(step2.tasks[0].completed).toBe(false);
    expect(step2.pending).toEqual([{ uid: '1', completed: false, updatedAt: 2000 }]);
  });

  it('preserves pending local toggles when strictly newer than server and drops server-deleted items', () => {
    const toggled = applyOptimisticToggle(baseTasks, [], '1', true, 1000);
    const serverPayload: CompactTask[] = [
      { uid: '1', summary: 'Whole Milk', categories: ['Dairy'], completed: false, etag: 'e1b', lastModified: 800 },
      { uid: '3', summary: 'Eggs', categories: ['Dairy'], completed: false, etag: 'e3', lastModified: 900 },
    ];

    const reconciled = reconcileWatchTasks(serverPayload, toggled.pending);
    expect(reconciled.tasks).toEqual([
      { uid: '1', summary: 'Whole Milk', categories: ['Dairy'], completed: true, etag: 'e1b', lastModified: 1000 },
      { uid: '3', summary: 'Eggs', categories: ['Dairy'], completed: false, etag: 'e3', lastModified: 900 },
    ]);
    expect(reconciled.pending).toEqual([{ uid: '1', completed: true, updatedAt: 1000 }]);
    expect(reconciled.togglesToSync).toEqual([{ uid: '1', completed: true, updatedAt: 1000 }]);
    expect(reconciled.discardedPendingUids).toEqual([]);

    // mergeWatchTasks helper matches reconciled.tasks
    expect(mergeWatchTasks(serverPayload, toggled.pending)).toEqual(reconciled.tasks);
  });

  it('prefers newer or equal server changes over older unsynced local watch toggles', () => {
    const pending = [
      { uid: '1', completed: true, updatedAt: 1000 },  // older than server (1500) → server wins
      { uid: '2', completed: true, updatedAt: 1000 },  // equal to server (1000) → server wins
      { uid: '3', completed: true, updatedAt: 2000 },  // newer than server (1200) → local wins
      { uid: '4', completed: true, updatedAt: 1000 },  // already matches server → dropped
      { uid: 'gone', completed: true, updatedAt: 2000 }, // deleted on server → dropped
    ];

    const serverPayload: CompactTask[] = [
      { uid: '1', summary: 'Milk', categories: ['Dairy'], completed: false, etag: 'e1', lastModified: 1500 },
      { uid: '2', summary: 'Bread', categories: ['Bakery'], completed: false, etag: 'e2', lastModified: 1000 },
      { uid: '3', summary: 'Apples', categories: ['Produce'], completed: false, etag: 'e3', lastModified: 1200 },
      { uid: '4', summary: 'Eggs', categories: ['Dairy'], completed: true, etag: 'e4', lastModified: 900 },
    ];

    const reconciled = reconcileWatchTasks(serverPayload, pending);
    expect(reconciled.tasks.map((t) => ({ uid: t.uid, completed: t.completed }))).toEqual([
      { uid: '1', completed: false },
      { uid: '2', completed: false },
      { uid: '3', completed: true },
      { uid: '4', completed: true },
    ]);
    expect(reconciled.pending).toEqual([{ uid: '3', completed: true, updatedAt: 2000 }]);
    expect(reconciled.togglesToSync).toEqual([{ uid: '3', completed: true, updatedAt: 2000 }]);
    expect(reconciled.discardedPendingUids.sort()).toEqual(['1', '2', '4', 'gone']);
  });

  it('keeps local toggle when server task has no lastModified timestamp', () => {
    const pending = [{ uid: '1', completed: true, updatedAt: 1000 }];
    const serverPayload: CompactTask[] = [
      { uid: '1', summary: 'Milk', categories: ['Dairy'], completed: false, etag: 'e1' },
    ];

    const reconciled = reconcileWatchTasks(serverPayload, pending);
    expect(reconciled.tasks[0].completed).toBe(true);
    expect(reconciled.togglesToSync).toEqual(pending);
  });

  it('acknowledges toggles with string etag or server-override metadata and ignores unknown uids', () => {
    const toggled = applyOptimisticToggle(baseTasks, [], '1', true, 1000);
    const acked = acknowledgeWatchToggle(toggled.tasks, toggled.pending, '1', 'e1-new');
    expect(acked.pending).toEqual([]);
    expect(acked.tasks[0].etag).toBe('e1-new');

    // Server-wins ACK can override completed and lastModified
    const toggled2 = applyOptimisticToggle(acked.tasks, acked.pending, '2', true, 1200);
    const serverWon = acknowledgeWatchToggle(toggled2.tasks, toggled2.pending, '2', {
      etag: 'e2-newer',
      completed: false,
      lastModified: 1500,
    });
    expect(serverWon.pending).toEqual([]);
    expect(serverWon.tasks[1]).toMatchObject({
      uid: '2',
      completed: false,
      etag: 'e2-newer',
      lastModified: 1500,
    });

    const unknown = acknowledgeWatchToggle(serverWon.tasks, serverWon.pending, 'unknown-uid', 'e9');
    expect(unknown.tasks).toEqual(serverWon.tasks);
    expect(unknown.pending).toEqual([]);
  });
});

describe('watch message chunking and reassembly', () => {
  it('sends a single TASKS_PAYLOAD for empty or small task lists', () => {
    const emptyMsgs = chunkTasksPayload([]);
    expect(emptyMsgs).toEqual([{ type: 'TASKS_PAYLOAD', tasks: [] }]);

    const small: CompactTask[] = [
      { uid: '1', summary: 'Milk', categories: ['Dairy'], completed: false },
    ];
    const msgs = chunkTasksPayload(small, { maxBytes: 900, categoryOrder: ['Dairy'] });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].type).toBe('TASKS_PAYLOAD');
  });

  it('splits oversized payloads into <= maxBytes chunks and reassembles out-of-order and duplicate chunks', () => {
    const tasks: CompactTask[] = [];
    for (let i = 0; i < 20; i++) {
      tasks.push({
        uid: `task-${i}`,
        summary: `Grocery item number ${i} with description`,
        categories: ['Produce'],
        completed: i % 2 === 0,
        etag: `etag-${i}`,
      });
    }

    const messages = chunkTasksPayload(tasks, {
      maxBytes: 350,
      transferId: 'tx-1',
      calendarHref: '/cal/shopping/',
      categoryOrder: ['Produce', 'Dairy'],
    });
    expect(messages.length).toBeGreaterThan(2);
    for (const msg of messages) {
      expect(msg.type).toBe('TASKS_CHUNK');
      expect(utf8ByteLength(JSON.stringify(msg))).toBeLessThanOrEqual(350);
    }

    const reassembler = createChunkReassembler();
    expect(reassembler.accept({ type: 'ERROR', message: 'boom' })).toBeNull();
    expect(reassembler.accept({ type: 'UNKNOWN' } as unknown as CompanionToWatchMessage)).toBeNull();

    const reversed = messages.slice().reverse();
    let result = null;
    for (let i = 0; i < reversed.length; i++) {
      if (i === 1) {
        expect(reassembler.accept(reversed[0])).toBeNull();
      }
      result = reassembler.accept(reversed[i]);
    }

    expect(result).toEqual({
      tasks,
      calendarHref: '/cal/shopping/',
      categoryOrder: ['Produce', 'Dairy'],
    });
  });

  it('computes multi-byte UTF-8 lengths accurately', () => {
    expect(utf8ByteLength('abc')).toBe(3);
    expect(utf8ByteLength('café')).toBe(5);
    expect(utf8ByteLength('🥛')).toBe(4);
  });
});
