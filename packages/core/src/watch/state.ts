import type { CompactTask, PendingWatchToggle } from './types.js';

export interface WatchStateUpdate {
  tasks: CompactTask[];
  pending: PendingWatchToggle[];
}

export interface WatchReconcileResult {
  tasks: CompactTask[];
  pending: PendingWatchToggle[];
  /** Pending local toggles that are strictly newer than the server and should be synced up. */
  togglesToSync: PendingWatchToggle[];
  /** UIDs whose pending local toggles were superseded by newer/equal server state or server deletion. */
  discardedPendingUids: string[];
}

export interface AcknowledgeWatchToggleMeta {
  etag?: string;
  completed?: boolean;
  lastModified?: number;
}

function cloneTask(
  task: CompactTask,
  completed: boolean,
  etag?: string,
  lastModified?: number,
): CompactTask {
  var copy: CompactTask = {
    uid: task.uid,
    summary: task.summary,
    categories: task.categories.slice(),
    completed: completed,
  };
  if (etag !== undefined) {
    copy.etag = etag;
  } else if (task.etag !== undefined) {
    copy.etag = task.etag;
  }
  if (lastModified !== undefined) {
    copy.lastModified = lastModified;
  } else if (task.lastModified !== undefined) {
    copy.lastModified = task.lastModified;
  }
  return copy;
}

function clonePending(entry: PendingWatchToggle): PendingWatchToggle {
  return {
    uid: entry.uid,
    completed: entry.completed,
    updatedAt: entry.updatedAt,
  };
}

/**
 * Applies an optimistic completion toggle to the watch's local task list
 * and records/updates the pending toggle entry with its local timestamp.
 */
export function applyOptimisticToggle(
  tasks: readonly CompactTask[],
  pending: readonly PendingWatchToggle[],
  uid: string,
  completed: boolean,
  nowMs?: number,
): WatchStateUpdate {
  var timestamp = nowMs !== undefined ? nowMs : Date.now();
  var nextTasks: CompactTask[] = [];
  for (var i = 0; i < tasks.length; i++) {
    var task = tasks[i];
    if (task.uid === uid) {
      nextTasks.push(cloneTask(task, completed, task.etag, timestamp));
    } else {
      nextTasks.push(cloneTask(task, task.completed));
    }
  }

  var nextPending: PendingWatchToggle[] = [];
  var updated = false;
  for (var j = 0; j < pending.length; j++) {
    var entry = pending[j];
    if (entry.uid === uid) {
      nextPending.push({ uid: uid, completed: completed, updatedAt: timestamp });
      updated = true;
    } else {
      nextPending.push(clonePending(entry));
    }
  }
  if (!updated) {
    nextPending.push({ uid: uid, completed: completed, updatedAt: timestamp });
  }

  return { tasks: nextTasks, pending: nextPending };
}

/**
 * Removes an acknowledged toggle from the watch's pending queue and updates
 * the matching task's ETag, completion state (if server won), and lastModified.
 * Accepts either an ETag string or a metadata object. Unknown UIDs are safely ignored.
 */
export function acknowledgeWatchToggle(
  tasks: readonly CompactTask[],
  pending: readonly PendingWatchToggle[],
  uid: string,
  etagOrMeta?: string | AcknowledgeWatchToggleMeta,
): WatchStateUpdate {
  var meta: AcknowledgeWatchToggleMeta =
    typeof etagOrMeta === 'string'
      ? { etag: etagOrMeta }
      : etagOrMeta || {};

  var nextPending: PendingWatchToggle[] = [];
  for (var i = 0; i < pending.length; i++) {
    if (pending[i].uid !== uid) {
      nextPending.push(clonePending(pending[i]));
    }
  }

  var nextTasks: CompactTask[] = [];
  for (var j = 0; j < tasks.length; j++) {
    var task = tasks[j];
    if (task.uid === uid) {
      var nextCompleted = meta.completed !== undefined ? meta.completed : task.completed;
      var nextEtag = meta.etag !== undefined ? meta.etag : task.etag;
      var nextLastMod = meta.lastModified !== undefined ? meta.lastModified : task.lastModified;
      nextTasks.push(cloneTask(task, nextCompleted, nextEtag, nextLastMod));
    } else {
      nextTasks.push(cloneTask(task, task.completed));
    }
  }

  return { tasks: nextTasks, pending: nextPending };
}

/**
 * Reconciles a fresh server task list with unsynced local watch toggles.
 *
 * Conflict policy (server-preferred when newer or equal):
 * - If a server task has `lastModified >= pending.updatedAt`, the server state wins
 *   and the stale local pending toggle is discarded.
 * - If the server already matches `pending.completed`, the pending toggle is dropped.
 * - If the local pending toggle is strictly newer (`pending.updatedAt > server.lastModified`,
 *   or server has no `lastModified`), the local completion state is preserved and returned
 *   in `togglesToSync` so the watch can push it up to the server.
 * - Tasks removed on the server are dropped along with any pending toggles for them.
 */
export function reconcileWatchTasks(
  serverTasks: readonly CompactTask[],
  pending: readonly PendingWatchToggle[],
): WatchReconcileResult {
  var pendingByUid: { [uid: string]: PendingWatchToggle } = {};
  for (var i = 0; i < pending.length; i++) {
    pendingByUid[pending[i].uid] = pending[i];
  }

  var merged: CompactTask[] = [];
  var remainingPending: PendingWatchToggle[] = [];
  var togglesToSync: PendingWatchToggle[] = [];
  var discardedPendingUids: string[] = [];
  var seenUids: { [uid: string]: boolean } = {};

  for (var j = 0; j < serverTasks.length; j++) {
    var serverTask = serverTasks[j];
    seenUids[serverTask.uid] = true;
    var pendingEntry = pendingByUid[serverTask.uid];

    if (!pendingEntry) {
      merged.push(cloneTask(serverTask, serverTask.completed));
      continue;
    }

    if (serverTask.completed === pendingEntry.completed) {
      // Server already reflects this completion state; drop redundant pending toggle
      merged.push(cloneTask(serverTask, serverTask.completed));
      discardedPendingUids.push(serverTask.uid);
      continue;
    }

    var serverIsNewerOrEqual =
      serverTask.lastModified !== undefined &&
      serverTask.lastModified >= pendingEntry.updatedAt;

    if (serverIsNewerOrEqual) {
      // Newer (or equal) change on server takes precedence over older local watch toggle
      merged.push(cloneTask(serverTask, serverTask.completed));
      discardedPendingUids.push(serverTask.uid);
    } else {
      // Local watch toggle is strictly newer than server's last modification
      merged.push(
        cloneTask(serverTask, pendingEntry.completed, serverTask.etag, pendingEntry.updatedAt),
      );
      var kept = clonePending(pendingEntry);
      remainingPending.push(kept);
      togglesToSync.push(clonePending(pendingEntry));
    }
  }

  // Drop pending toggles for tasks deleted on the server
  for (var k = 0; k < pending.length; k++) {
    if (!seenUids[pending[k].uid]) {
      discardedPendingUids.push(pending[k].uid);
    }
  }

  return {
    tasks: merged,
    pending: remainingPending,
    togglesToSync: togglesToSync,
    discardedPendingUids: discardedPendingUids,
  };
}

/**
 * Convenience helper returning the reconciled task array from `reconcileWatchTasks`.
 */
export function mergeWatchTasks(
  serverTasks: readonly CompactTask[],
  pending: readonly PendingWatchToggle[],
): CompactTask[] {
  return reconcileWatchTasks(serverTasks, pending).tasks;
}
