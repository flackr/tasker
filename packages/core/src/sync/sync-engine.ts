import { CalDavClient } from '../caldav/client.js';
import { CalDavError } from '../caldav/http.js';
import { generateUid } from '../caldav/vtodo.js';
import type { Task } from '../types.js';
import {
  resolveConflict,
  type ConflictStrategy,
  type ConflictWinner,
  type SyncConflict,
} from './conflict.js';
import type { SyncStorage } from './store.js';

export interface CreateTaskInput {
  uid?: string;
  summary: string;
  description?: string;
  categories?: string[];
  priority?: number;
  dtstart?: string;
  due?: string;
}

export interface FlushQueueOptions {
  conflictStrategy?: ConflictStrategy;
  now?: Date;
}

export interface FlushQueueResult {
  processed: number;
  remaining: number;
  conflicts: SyncConflict[];
}

export interface FullSyncOptions {
  force?: boolean;
  conflictStrategy?: ConflictStrategy;
  now?: Date;
}

export interface FullSyncResult {
  ctagChanged: boolean;
  pulled: number;
  pruned: number;
  flush: FlushQueueResult;
}

function ensureTrailingSlash(path: string): string {
  return path.charAt(path.length - 1) === '/' ? path : path + '/';
}

/**
 * Storage-agnostic offline-first CalDAV sync engine.
 * Works with any `SyncStorage` adapter (IndexedDB in PWA, in-memory in tests, etc.).
 */
export class SyncEngine {
  private readonly client: CalDavClient;
  private readonly storage: SyncStorage;

  constructor(client: CalDavClient, storage: SyncStorage) {
    this.client = client;
    this.storage = storage;
  }

  /**
   * Optimistically creates a task locally and enqueues a CalDAV `PUT` operation.
   */
  async createTask(
    calendarHref: string,
    input: CreateTaskInput,
    now: Date = new Date(),
  ): Promise<Task> {
    const uid = input.uid || generateUid();
    const nowIso = now.toISOString();
    const task: Task = {
      uid,
      calendarHref,
      href: `${ensureTrailingSlash(calendarHref)}${encodeURIComponent(uid)}.ics`,
      summary: input.summary,
      status: 'NEEDS-ACTION',
      categories: input.categories ? input.categories.slice() : [],
      created: nowIso,
      lastModified: nowIso,
      dirty: true,
    };
    if (input.description !== undefined) task.description = input.description;
    if (input.priority !== undefined) task.priority = input.priority;
    if (input.dtstart !== undefined) task.dtstart = input.dtstart;
    if (input.due !== undefined) task.due = input.due;

    await this.storage.tasks.putTask(task);
    await this.storage.queue.enqueue({
      type: 'create',
      uid: task.uid,
      calendarHref,
      task,
      queuedAt: nowIso,
    });
    return task;
  }

  /**
   * Optimistically updates a task locally and enqueues (or coalesces) a CalDAV `PUT`.
   */
  async updateTask(task: Task, now: Date = new Date()): Promise<Task> {
    const existing = await this.storage.tasks.getTask(task.uid);
    const calendarHref = task.calendarHref || existing?.calendarHref;
    if (!calendarHref) {
      throw new Error(`Cannot update task "${task.uid}" without calendarHref`);
    }

    const nowIso = now.toISOString();
    const updated: Task = {
      ...existing,
      ...task,
      calendarHref,
      href:
        task.href ||
        existing?.href ||
        `${ensureTrailingSlash(calendarHref)}${encodeURIComponent(task.uid)}.ics`,
      categories: task.categories.slice(),
      lastModified: nowIso,
      dirty: true,
    };

    await this.storage.tasks.putTask(updated);

    // Coalesce with any already-queued create/update for this UID so expectedEtag is preserved
    const pending = await this.storage.queue.list();
    for (let i = 0; i < pending.length; i++) {
      const op = pending[i];
      if (op.uid === updated.uid && (op.type === 'create' || op.type === 'update')) {
        await this.storage.queue.update({
          ...op,
          task: updated,
          queuedAt: nowIso,
        });
        return updated;
      }
    }

    await this.storage.queue.enqueue({
      type: 'update',
      uid: updated.uid,
      calendarHref,
      task: updated,
      expectedEtag: existing?.etag ?? updated.etag,
      queuedAt: nowIso,
    });

    return updated;
  }

  /**
   * Toggles completion status of a task locally and enqueues an update.
   */
  async toggleTask(uid: string, completed?: boolean, now: Date = new Date()): Promise<Task> {
    const existing = await this.storage.tasks.getTask(uid);
    if (!existing) {
      throw new Error(`Task "${uid}" not found`);
    }
    const nextCompleted = completed !== undefined ? completed : existing.status !== 'COMPLETED';
    const nowIso = now.toISOString();
    return this.updateTask(
      {
        ...existing,
        status: nextCompleted ? 'COMPLETED' : 'NEEDS-ACTION',
        percentComplete: nextCompleted ? 100 : 0,
        completedAt: nextCompleted ? nowIso : undefined,
      },
      now,
    );
  }

  /**
   * Deletes a task locally and enqueues a CalDAV `DELETE` (or cancels an unsynced `create`).
   */
  async deleteTask(uid: string, now: Date = new Date()): Promise<void> {
    const existing = await this.storage.tasks.getTask(uid);
    const pending = await this.storage.queue.list();

    let cancelledCreate = false;
    let calendarHref = existing?.calendarHref;
    let expectedEtag = existing?.etag;

    for (let i = 0; i < pending.length; i++) {
      const op = pending[i];
      if (op.uid !== uid) continue;
      if (op.calendarHref && !calendarHref) calendarHref = op.calendarHref;
      if (op.expectedEtag && !expectedEtag) expectedEtag = op.expectedEtag;
      if (op.type === 'create') {
        cancelledCreate = true;
      }
      if (op.id !== undefined) {
        await this.storage.queue.remove(op.id);
      }
    }

    await this.storage.tasks.deleteTask(uid);

    if (cancelledCreate || !calendarHref) {
      return;
    }

    await this.storage.queue.enqueue({
      type: 'delete',
      uid,
      calendarHref,
      task: existing,
      expectedEtag,
      queuedAt: now.toISOString(),
    });
  }

  /**
   * Replays all pending operations in FIFO order against CalDAV.
   */
  async flushQueue(options?: FlushQueueOptions): Promise<FlushQueueResult> {
    const strategy: ConflictStrategy = options?.conflictStrategy ?? 'auto';
    const now = options?.now ?? new Date();
    const operations = await this.storage.queue.list();
    const conflicts: SyncConflict[] = [];
    let processed = 0;

    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      if (op.id === undefined) continue;

      if (op.type === 'create' || op.type === 'update') {
        const localTask = (await this.storage.tasks.getTask(op.uid)) || op.task;
        if (!localTask) {
          await this.storage.queue.remove(op.id);
          continue;
        }

        try {
          const putResult = await this.client.putTask(op.calendarHref, localTask, {
            ifMatch: op.type === 'update' ? op.expectedEtag : undefined,
            now,
          });
          await this.storage.tasks.putTask({
            ...localTask,
            href: putResult.href,
            etag: putResult.etag,
            rawIcs: putResult.ics,
            dirty: false,
          });
          await this.storage.queue.remove(op.id);
          processed += 1;
        } catch (err) {
          if (err instanceof CalDavError && err.code === 'PRECONDITION_FAILED') {
            const taskHref =
              localTask.href ||
              `${ensureTrailingSlash(op.calendarHref)}${encodeURIComponent(op.uid)}.ics`;
            const serverTask = await this.client.getTask(taskHref, op.calendarHref);

            if (strategy === 'manual') {
              conflicts.push({
                uid: op.uid,
                calendarHref: op.calendarHref,
                local: localTask,
                server: serverTask,
                operation: op,
              });
              continue;
            }

            const resolution = resolveConflict(localTask, serverTask);
            if (resolution.winner === 'local') {
              const retryResult = await this.client.putTask(op.calendarHref, resolution.task, {
                ifMatch: serverTask.etag,
                now,
              });
              await this.storage.tasks.putTask({
                ...resolution.task,
                href: retryResult.href,
                etag: retryResult.etag,
                rawIcs: retryResult.ics,
                dirty: false,
              });
            } else {
              await this.storage.tasks.putTask({ ...resolution.task, dirty: false });
            }
            await this.storage.queue.remove(op.id);
            processed += 1;
          } else {
            throw err;
          }
        }
      } else if (op.type === 'delete') {
        const taskHref =
          op.task?.href ||
          `${ensureTrailingSlash(op.calendarHref)}${encodeURIComponent(op.uid)}.ics`;
        try {
          await this.client.deleteTask(taskHref, { ifMatch: op.expectedEtag });
          await this.storage.queue.remove(op.id);
          processed += 1;
        } catch (err) {
          if (err instanceof CalDavError && err.code === 'NOT_FOUND') {
            await this.storage.queue.remove(op.id);
            processed += 1;
          } else if (err instanceof CalDavError && err.code === 'PRECONDITION_FAILED') {
            const serverTask = await this.client.getTask(taskHref, op.calendarHref);
            if (strategy === 'manual' && op.task) {
              conflicts.push({
                uid: op.uid,
                calendarHref: op.calendarHref,
                local: op.task,
                server: serverTask,
                operation: op,
              });
              continue;
            }
            // In auto mode, server modified the task after our snapshot → keep server version
            await this.storage.tasks.putTask({ ...serverTask, dirty: false });
            await this.storage.queue.remove(op.id);
            processed += 1;
          } else {
            throw err;
          }
        }
      }
    }

    const remaining = (await this.storage.queue.list()).length;
    return { processed, remaining, conflicts };
  }

  /**
   * Resolves a manual conflict returned by `flushQueue({ conflictStrategy: 'manual' })`.
   */
  async resolveManualConflict(
    conflict: SyncConflict,
    choice: ConflictWinner,
    now: Date = new Date(),
  ): Promise<void> {
    if (choice === 'server') {
      await this.storage.tasks.putTask({ ...conflict.server, dirty: false });
    } else if (conflict.operation.type === 'delete') {
      const taskHref =
        conflict.server.href ||
        `${ensureTrailingSlash(conflict.calendarHref)}${encodeURIComponent(conflict.uid)}.ics`;
      await this.client.deleteTask(taskHref, { ifMatch: conflict.server.etag });
      await this.storage.tasks.deleteTask(conflict.uid);
    } else {
      const mergedLocal: Task = {
        ...conflict.local,
        href: conflict.server.href ?? conflict.local.href,
        etag: conflict.server.etag,
        rawIcs: conflict.server.rawIcs ?? conflict.local.rawIcs,
      };
      const putResult = await this.client.putTask(conflict.calendarHref, mergedLocal, {
        ifMatch: conflict.server.etag,
        now,
      });
      await this.storage.tasks.putTask({
        ...mergedLocal,
        href: putResult.href,
        etag: putResult.etag,
        rawIcs: putResult.ics,
        dirty: false,
      });
    }

    if (conflict.operation.id !== undefined) {
      await this.storage.queue.remove(conflict.operation.id);
    }
  }

  /**
   * Runs a full synchronization cycle for a calendar:
   * 1. Checks collection CTag; if changed (or `force`), fetches all VTODOs and diffs against local store
   *    (skipping tasks with pending local queue entries so offline edits are never clobbered).
   * 2. Flushes pending queue operations (`PUT`/`DELETE` with `If-Match`).
   * 3. Updates stored CTag after successful writes so the next sync stays incremental.
   */
  async fullSync(calendarHref: string, options?: FullSyncOptions): Promise<FullSyncResult> {
    const storedCal = await this.storage.calendars.getCalendar(calendarHref);
    const remoteCTag = await this.client.getCalendarCTag(calendarHref);
    const ctagChanged =
      Boolean(options?.force) ||
      remoteCTag === undefined ||
      storedCal?.ctag !== remoteCTag;

    let pulled = 0;
    let pruned = 0;

    if (ctagChanged) {
      const pendingOps = await this.storage.queue.list();
      const pendingUids: { [uid: string]: boolean } = {};
      for (let i = 0; i < pendingOps.length; i++) {
        pendingUids[pendingOps[i].uid] = true;
      }

      const remoteTasks = await this.client.fetchTasks(calendarHref);
      const localTasks = await this.storage.tasks.getTasksByCalendar(calendarHref);
      const localByUid: { [uid: string]: Task } = {};
      for (let i = 0; i < localTasks.length; i++) {
        localByUid[localTasks[i].uid] = localTasks[i];
      }

      const remoteUids: { [uid: string]: boolean } = {};
      for (let i = 0; i < remoteTasks.length; i++) {
        const remote = remoteTasks[i];
        remoteUids[remote.uid] = true;
        if (pendingUids[remote.uid]) {
          continue;
        }
        const local = localByUid[remote.uid];
        if (!local || local.etag !== remote.etag) {
          await this.storage.tasks.putTask({ ...remote, calendarHref, dirty: false });
          pulled += 1;
        }
      }

      for (let i = 0; i < localTasks.length; i++) {
        const local = localTasks[i];
        if (!remoteUids[local.uid] && !pendingUids[local.uid] && !local.dirty) {
          await this.storage.tasks.deleteTask(local.uid);
          pruned += 1;
        }
      }

      await this.storage.calendars.putCalendar({
        href: calendarHref,
        displayName: storedCal?.displayName ?? calendarHref,
        ctag: remoteCTag,
      });
    }

    const flush = await this.flushQueue({
      conflictStrategy: options?.conflictStrategy,
      now: options?.now,
    });

    if (flush.processed > 0) {
      const postFlushCTag = await this.client.getCalendarCTag(calendarHref);
      const latestCal = await this.storage.calendars.getCalendar(calendarHref);
      await this.storage.calendars.putCalendar({
        href: calendarHref,
        displayName: latestCal?.displayName ?? calendarHref,
        ctag: postFlushCTag,
      });
    }

    return { ctagChanged, pulled, pruned, flush };
  }
}
