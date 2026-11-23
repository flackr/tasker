export type TaskStatus = 'NEEDS-ACTION' | 'COMPLETED' | 'IN-PROCESS' | 'CANCELLED';

/**
 * Compact task representation exchanged between Fitbit Companion and Watch App.
 */
export interface CompactTask {
  uid: string;
  summary: string;
  categories: string[];
  completed: boolean;
  etag?: string;
}

/**
 * Unacknowledged completion toggle queued locally on the watch while offline
 * or awaiting Companion confirmation.
 */
export interface PendingWatchToggle {
  uid: string;
  completed: boolean;
  updatedAt: number;
}

export type WatchToCompanionMessage =
  | { type: 'FETCH_TASKS'; calendarHref?: string }
  | { type: 'UPDATE_TASK'; uid: string; completed: boolean; calendarHref?: string };

export interface TasksChunkMessage {
  type: 'TASKS_CHUNK';
  transferId: string;
  chunkIndex: number;
  totalChunks: number;
  tasks: CompactTask[];
  calendarHref?: string;
  aisleOrder?: string[];
}

export type CompanionToWatchMessage =
  | { type: 'TASKS_PAYLOAD'; tasks: CompactTask[]; calendarHref?: string; aisleOrder?: string[] }
  | TasksChunkMessage
  | { type: 'UPDATE_ACK'; uid: string; etag?: string }
  | { type: 'ERROR'; message: string };
