export type TaskStatus = 'NEEDS-ACTION' | 'COMPLETED' | 'IN-PROCESS' | 'CANCELLED';

/**
 * Compact calendar/list descriptor sent to the Fitbit Watch App.
 */
export interface CompactCalendar {
  href: string;
  displayName: string;
}

/**
 * Compact task representation exchanged between Fitbit Companion and Watch App.
 */
export interface CompactTask {
  uid: string;
  summary: string;
  categories: string[];
  completed: boolean;
  etag?: string;
  /** UTC epoch milliseconds of the task's last modification (from CalDAV LAST-MODIFIED). */
  lastModified?: number;
}

/**
 * Unacknowledged completion toggle queued locally on the watch while offline
 * or awaiting Companion confirmation.
 */
export interface PendingWatchToggle {
  uid: string;
  completed: boolean;
  /** UTC epoch milliseconds when the user toggled the item on the watch. */
  updatedAt: number;
}

export type WatchToCompanionMessage =
  | { type: 'FETCH_LISTS' }
  | { type: 'FETCH_TASKS'; calendarHref?: string }
  | {
      type: 'UPDATE_TASK';
      uid: string;
      completed: boolean;
      calendarHref?: string;
      updatedAt?: number;
    };

export interface TasksChunkMessage {
  type: 'TASKS_CHUNK';
  transferId: string;
  chunkIndex: number;
  totalChunks: number;
  tasks: CompactTask[];
  calendarHref?: string;
  categoryOrder?: string[];
}

export type CompanionToWatchMessage =
  | {
      type: 'LISTS_PAYLOAD';
      calendars: CompactCalendar[];
      defaultCalendarHref?: string;
      categoryOrder?: string[];
    }
  | { type: 'TASKS_PAYLOAD'; tasks: CompactTask[]; calendarHref?: string; categoryOrder?: string[] }
  | TasksChunkMessage
  | {
      type: 'UPDATE_ACK';
      uid: string;
      calendarHref?: string;
      completed?: boolean;
      etag?: string;
      lastModified?: number;
    }
  | { type: 'ERROR'; message: string };
