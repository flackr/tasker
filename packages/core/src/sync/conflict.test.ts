import { describe, expect, it } from 'vitest';
import type { Task } from '../types.js';
import { resolveConflict } from './conflict.js';

const baseTask: Task = {
  uid: 'task-1',
  summary: 'Milk',
  status: 'NEEDS-ACTION',
  categories: ['Dairy'],
  etag: 'etag-1',
  href: '/cal/shopping/task-1.ics',
  rawIcs: 'RAW-SERVER',
};

describe('resolveConflict', () => {
  it('picks local when local lastModified is strictly newer and carries server etag/rawIcs', () => {
    const local: Task = {
      ...baseTask,
      summary: 'Organic Milk',
      lastModified: '2026-05-01T12:05:00.000Z',
      etag: 'etag-old',
      rawIcs: 'RAW-OLD',
      dirty: true,
    };
    const server: Task = {
      ...baseTask,
      summary: 'Whole Milk',
      lastModified: '2026-05-01T12:00:00.000Z',
      etag: 'etag-new',
      rawIcs: 'RAW-NEW',
    };

    const res = resolveConflict(local, server);
    expect(res.winner).toBe('local');
    expect(res.reason).toBe('local-newer');
    expect(res.task.summary).toBe('Organic Milk');
    expect(res.task.etag).toBe('etag-new');
    expect(res.task.rawIcs).toBe('RAW-NEW');
  });

  it('picks server when server lastModified is strictly newer', () => {
    const local: Task = {
      ...baseTask,
      summary: 'Local Old',
      lastModified: '2026-05-01T11:55:00.000Z',
      dirty: true,
    };
    const server: Task = {
      ...baseTask,
      summary: 'Server Newer',
      lastModified: '2026-05-01T12:00:00.000Z',
      etag: 'etag-2',
    };

    const res = resolveConflict(local, server);
    expect(res.winner).toBe('server');
    expect(res.reason).toBe('server-newer');
    expect(res.task.summary).toBe('Server Newer');
    expect(res.task.dirty).toBe(false);
  });

  it('picks server on equal timestamps', () => {
    const local: Task = {
      ...baseTask,
      summary: 'Local Tie',
      lastModified: '2026-05-01T12:00:00.000Z',
    };
    const server: Task = {
      ...baseTask,
      summary: 'Server Tie',
      lastModified: '2026-05-01T12:00:00.000Z',
    };

    const res = resolveConflict(local, server);
    expect(res.winner).toBe('server');
    expect(res.reason).toBe('equal-server-wins');
    expect(res.task.summary).toBe('Server Tie');
  });

  it('picks server when either timestamp is missing or unparseable', () => {
    const missingLocal = resolveConflict(
      { ...baseTask, lastModified: undefined },
      { ...baseTask, summary: 'Server', lastModified: '2026-05-01T12:00:00.000Z' },
    );
    expect(missingLocal.winner).toBe('server');
    expect(missingLocal.reason).toBe('missing-timestamp-server-wins');

    const invalidServer = resolveConflict(
      { ...baseTask, lastModified: '2026-05-01T12:00:00.000Z' },
      { ...baseTask, summary: 'Server', lastModified: 'not-a-date' },
    );
    expect(invalidServer.winner).toBe('server');
    expect(invalidServer.reason).toBe('missing-timestamp-server-wins');
  });
});
