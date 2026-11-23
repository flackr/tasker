import type { CompactTask, CompanionToWatchMessage, TasksChunkMessage } from './types.js';

export interface ChunkOptions {
  /** Maximum JSON payload size in UTF-8 bytes per message (default 900). */
  maxBytes?: number;
  transferId?: string;
  calendarHref?: string;
  aisleOrder?: string[];
}

export interface ReassembledTasksPayload {
  tasks: CompactTask[];
  calendarHref?: string;
  aisleOrder?: string[];
}

export interface ChunkReassembler {
  accept(message: CompanionToWatchMessage): ReassembledTasksPayload | null;
  reset(): void;
}

/**
 * Computes the UTF-8 byte length of a string (ES5-safe, no TextEncoder).
 */
export function utf8ByteLength(value: string): number {
  var bytes = 0;
  for (var i = 0; i < value.length; i++) {
    var code = value.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      var next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Encodes a task list into either a single TASKS_PAYLOAD message (when it fits
 * within `maxBytes`) or a sequence of TASKS_CHUNK messages suitable for Fitbit
 * peerSocket messaging.
 */
export function chunkTasksPayload(
  tasks: readonly CompactTask[],
  options?: ChunkOptions,
): CompanionToWatchMessage[] {
  var maxBytes = options && options.maxBytes !== undefined ? options.maxBytes : 900;
  var calendarHref = options ? options.calendarHref : undefined;
  var aisleOrder = options ? options.aisleOrder : undefined;

  var single: CompanionToWatchMessage = {
    type: 'TASKS_PAYLOAD',
    tasks: tasks.slice(),
  };
  if (calendarHref !== undefined) single.calendarHref = calendarHref;
  if (aisleOrder !== undefined) single.aisleOrder = aisleOrder.slice();

  if (tasks.length === 0 || utf8ByteLength(JSON.stringify(single)) <= maxBytes) {
    return [single];
  }

  var transferId = options && options.transferId ? options.transferId : String(Date.now());
  var buckets: CompactTask[][] = [];
  var current: CompactTask[] = [];

  for (var i = 0; i < tasks.length; i++) {
    var candidate = current.concat([tasks[i]]);
    var probe: TasksChunkMessage = {
      type: 'TASKS_CHUNK',
      transferId: transferId,
      chunkIndex: buckets.length,
      totalChunks: 999,
      tasks: candidate,
    };
    if (buckets.length === 0) {
      if (calendarHref !== undefined) probe.calendarHref = calendarHref;
      if (aisleOrder !== undefined) probe.aisleOrder = aisleOrder.slice();
    }

    if (current.length > 0 && utf8ByteLength(JSON.stringify(probe)) > maxBytes) {
      buckets.push(current);
      current = [tasks[i]];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    buckets.push(current);
  }

  var messages: TasksChunkMessage[] = [];
  for (var j = 0; j < buckets.length; j++) {
    var chunk: TasksChunkMessage = {
      type: 'TASKS_CHUNK',
      transferId: transferId,
      chunkIndex: j,
      totalChunks: buckets.length,
      tasks: buckets[j],
    };
    if (j === 0) {
      if (calendarHref !== undefined) chunk.calendarHref = calendarHref;
      if (aisleOrder !== undefined) chunk.aisleOrder = aisleOrder.slice();
    }
    messages.push(chunk);
  }
  return messages;
}

/**
 * Reassembles TASKS_PAYLOAD and chunked TASKS_CHUNK messages on the watch.
 * Handles out-of-order and duplicate chunks, and ignores unknown message types.
 */
export function createChunkReassembler(): ChunkReassembler {
  var activeTransferId: string | null = null;
  var expectedTotal = 0;
  var receivedCount = 0;
  var chunks: { [index: number]: CompactTask[] } = {};
  var calendarHref: string | undefined = undefined;
  var aisleOrder: string[] | undefined = undefined;

  function reset(): void {
    activeTransferId = null;
    expectedTotal = 0;
    receivedCount = 0;
    chunks = {};
    calendarHref = undefined;
    aisleOrder = undefined;
  }

  function accept(message: CompanionToWatchMessage): ReassembledTasksPayload | null {
    if (!message || typeof message !== 'object') {
      return null;
    }
    if (message.type === 'TASKS_PAYLOAD') {
      reset();
      return {
        tasks: message.tasks ? message.tasks.slice() : [],
        calendarHref: message.calendarHref,
        aisleOrder: message.aisleOrder ? message.aisleOrder.slice() : undefined,
      };
    }
    if (message.type !== 'TASKS_CHUNK') {
      return null;
    }
    if (
      message.totalChunks <= 0 ||
      message.chunkIndex < 0 ||
      message.chunkIndex >= message.totalChunks
    ) {
      return null;
    }

    if (activeTransferId !== message.transferId) {
      reset();
      activeTransferId = message.transferId;
      expectedTotal = message.totalChunks;
    }

    if (message.calendarHref !== undefined) {
      calendarHref = message.calendarHref;
    }
    if (message.aisleOrder !== undefined) {
      aisleOrder = message.aisleOrder.slice();
    }

    if (chunks[message.chunkIndex] === undefined) {
      chunks[message.chunkIndex] = message.tasks ? message.tasks.slice() : [];
      receivedCount += 1;
    }

    if (receivedCount < expectedTotal) {
      return null;
    }

    var allTasks: CompactTask[] = [];
    for (var i = 0; i < expectedTotal; i++) {
      var slice = chunks[i];
      if (slice) {
        for (var j = 0; j < slice.length; j++) {
          allTasks.push(slice[j]);
        }
      }
    }

    var result: ReassembledTasksPayload = {
      tasks: allTasks,
      calendarHref: calendarHref,
      aisleOrder: aisleOrder,
    };
    reset();
    return result;
  }

  return {
    accept: accept,
    reset: reset,
  };
}
