import type { SyncOperation, Task } from '../types.js';

export type ConflictStrategy = 'auto' | 'manual';

export type ConflictWinner = 'local' | 'server';

export type ConflictReason =
  | 'local-newer'
  | 'server-newer'
  | 'equal-server-wins'
  | 'missing-timestamp-server-wins';

export interface SyncConflict {
  uid: string;
  calendarHref: string;
  local: Task;
  server: Task;
  operation: SyncOperation;
}

export interface ConflictResolution {
  winner: ConflictWinner;
  task: Task;
  reason: ConflictReason;
}

function parseTimestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return isNaN(ms) ? null : ms;
}

/**
 * Deterministic last-write-wins conflict resolution based on `lastModified`.
 * - Local strictly newer → local wins (preserving server's ETag/rawIcs base for retry)
 * - Server strictly newer → server wins
 * - Equal timestamps or missing/invalid timestamp → server wins
 */
export function resolveConflict(local: Task, server: Task): ConflictResolution {
  const localMs = parseTimestampMs(local.lastModified);
  const serverMs = parseTimestampMs(server.lastModified);

  if (localMs === null || serverMs === null) {
    return {
      winner: 'server',
      task: { ...server, categories: server.categories.slice(), dirty: false },
      reason: 'missing-timestamp-server-wins',
    };
  }

  if (localMs > serverMs) {
    return {
      winner: 'local',
      task: {
        ...local,
        categories: local.categories.slice(),
        href: server.href ?? local.href,
        etag: server.etag,
        rawIcs: server.rawIcs ?? local.rawIcs,
      },
      reason: 'local-newer',
    };
  }

  if (serverMs > localMs) {
    return {
      winner: 'server',
      task: { ...server, categories: server.categories.slice(), dirty: false },
      reason: 'server-newer',
    };
  }

  return {
    winner: 'server',
    task: { ...server, categories: server.categories.slice(), dirty: false },
    reason: 'equal-server-wins',
  };
}
