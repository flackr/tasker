import type { CompactTask, PendingWatchToggle } from './types.js';

export interface WatchStateUpdate {
  tasks: CompactTask[];
  pending: PendingWatchToggle[];
}

function cloneTask(task: CompactTask, completed: boolean, etag?: string): CompactTask {
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
  return copy;
}

/**
 * Applies an optimistic completion toggle to the watch's local task list
 * and records/updates the pending toggle entry for later reconciliation.
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
      nextTasks.push(cloneTask(task, completed));
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
      nextPending.push({
        uid: entry.uid,
        completed: entry.completed,
        updatedAt: entry.updatedAt,
      });
    }
  }
  if (!updated) {
    nextPending.push({ uid: uid, completed: completed, updatedAt: timestamp });
  }

  return { tasks: nextTasks, pending: nextPending };
}

/**
 * Removes an acknowledged toggle from the watch's pending queue and updates
 * the matching task's ETag when provided. Unknown UIDs are safely ignored.
 */
export function acknowledgeWatchToggle(
  tasks: readonly CompactTask[],
  pending: readonly PendingWatchToggle[],
  uid: string,
  etag?: string,
): WatchStateUpdate {
  var nextPending: PendingWatchToggle[] = [];
  for (var i = 0; i < pending.length; i++) {
    if (pending[i].uid !== uid) {
      nextPending.push({
        uid: pending[i].uid,
        completed: pending[i].completed,
        updatedAt: pending[i].updatedAt,
      });
    }
  }

  var nextTasks: CompactTask[] = [];
  for (var j = 0; j < tasks.length; j++) {
    var task = tasks[j];
    if (task.uid === uid && etag !== undefined) {
      nextTasks.push(cloneTask(task, task.completed, etag));
    } else {
      nextTasks.push(cloneTask(task, task.completed));
    }
  }

  return { tasks: nextTasks, pending: nextPending };
}

/**
 * Merges a fresh server task list with unacknowledged local watch toggles.
 * Tasks deleted on the server are dropped; tasks with pending local toggles
 * retain their local `completed` state until acknowledged.
 */
export function mergeWatchTasks(
  serverTasks: readonly CompactTask[],
  pending: readonly PendingWatchToggle[],
): CompactTask[] {
  var pendingByUid: { [uid: string]: PendingWatchToggle } = {};
  for (var i = 0; i < pending.length; i++) {
    pendingByUid[pending[i].uid] = pending[i];
  }

  var merged: CompactTask[] = [];
  for (var j = 0; j < serverTasks.length; j++) {
    var serverTask = serverTasks[j];
    var pendingEntry = pendingByUid[serverTask.uid];
    if (pendingEntry) {
      merged.push(cloneTask(serverTask, pendingEntry.completed));
    } else {
      merged.push(cloneTask(serverTask, serverTask.completed));
    }
  }
  return merged;
}
