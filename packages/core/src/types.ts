import type { CompactTask, TaskStatus } from './watch/index.js';

export type {
  AcknowledgeWatchToggleMeta,
  AisleSortableTask,
  ChunkOptions,
  ChunkReassembler,
  CompactCalendar,
  CompactTask,
  CompanionToWatchMessage,
  PendingWatchToggle,
  ReassembledTasksPayload,
  TasksChunkMessage,
  TaskStatus,
  WatchReconcileResult,
  WatchStateUpdate,
  WatchToCompanionMessage,
} from './watch/index.js';

export interface Credentials {
  baseUrl: string;
  username: string;
  appPassword: string;
  calendarHref?: string;
  configPath?: string;
}

export interface CalendarInfo {
  href: string;
  displayName: string;
  ctag?: string;
}

export interface Task {
  uid: string;
  summary: string;
  status: TaskStatus | string;
  categories: string[];
  description?: string;
  priority?: number;
  percentComplete?: number;
  calendarHref?: string;
  href?: string;
  etag?: string;
  created?: string;
  lastModified?: string;
  completedAt?: string;
  dtstart?: string;
  due?: string;
  rawIcs?: string;
  dirty?: boolean;
}

export interface AisleConfig {
  aisles: string[];
}

export interface TaskerConfig {
  defaultCalendarHref?: string;
  recipesPath?: string;
  aisles?: string[];
}

export type SyncOperationType = 'create' | 'update' | 'delete';

export interface SyncOperation {
  id?: number;
  type: SyncOperationType;
  uid: string;
  calendarHref: string;
  task?: Task;
  expectedEtag?: string;
  queuedAt: string;
}

export function toCompactTask(task: Task): CompactTask {
  const compact: CompactTask = {
    uid: task.uid,
    summary: task.summary,
    categories: task.categories.slice(),
    completed: task.status === 'COMPLETED',
  };
  if (task.etag !== undefined) {
    compact.etag = task.etag;
  }
  if (task.lastModified !== undefined) {
    const ms = Date.parse(task.lastModified);
    if (!isNaN(ms)) {
      compact.lastModified = ms;
    }
  }
  return compact;
}
