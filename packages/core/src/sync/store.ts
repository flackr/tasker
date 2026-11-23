import type { CalendarInfo, SyncOperation, Task } from '../types.js';

export interface TaskStore {
  getTask(uid: string): Promise<Task | undefined>;
  getTasksByCalendar(calendarHref: string): Promise<Task[]>;
  putTask(task: Task): Promise<void>;
  deleteTask(uid: string): Promise<void>;
}

export interface CalendarMetadataStore {
  getCalendar(href: string): Promise<CalendarInfo | undefined>;
  getAllCalendars(): Promise<CalendarInfo[]>;
  putCalendar(calendar: CalendarInfo): Promise<void>;
  deleteCalendar(href: string): Promise<void>;
}

export interface SyncQueueStore {
  enqueue(operation: Omit<SyncOperation, 'id'>): Promise<number>;
  list(): Promise<SyncOperation[]>;
  update(operation: SyncOperation): Promise<void>;
  remove(id: number): Promise<void>;
  clear(): Promise<void>;
}

export interface SyncStorage {
  tasks: TaskStore;
  calendars: CalendarMetadataStore;
  queue: SyncQueueStore;
}

function cloneTask(task: Task): Task {
  return {
    ...task,
    categories: task.categories.slice(),
  };
}

function cloneOperation(op: SyncOperation): SyncOperation {
  return {
    ...op,
    task: op.task ? cloneTask(op.task) : undefined,
  };
}

/**
 * In-memory implementation of `SyncStorage` (`TaskStore`, `CalendarMetadataStore`,
 * and `SyncQueueStore`) for tests and lightweight environments.
 */
export class InMemorySyncStorage implements SyncStorage {
  private readonly taskMap = new Map<string, Task>();
  private readonly calendarMap = new Map<string, CalendarInfo>();
  private readonly queueList: SyncOperation[] = [];
  private nextQueueId = 1;

  readonly tasks: TaskStore = {
    getTask: async (uid: string) => {
      const found = this.taskMap.get(uid);
      return found ? cloneTask(found) : undefined;
    },
    getTasksByCalendar: async (calendarHref: string) => {
      const result: Task[] = [];
      this.taskMap.forEach((task) => {
        if (task.calendarHref === calendarHref) {
          result.push(cloneTask(task));
        }
      });
      return result;
    },
    putTask: async (task: Task) => {
      this.taskMap.set(task.uid, cloneTask(task));
    },
    deleteTask: async (uid: string) => {
      this.taskMap.delete(uid);
    },
  };

  readonly calendars: CalendarMetadataStore = {
    getCalendar: async (href: string) => {
      const found = this.calendarMap.get(href);
      return found ? { ...found } : undefined;
    },
    getAllCalendars: async () => {
      const result: CalendarInfo[] = [];
      this.calendarMap.forEach((cal) => result.push({ ...cal }));
      return result;
    },
    putCalendar: async (calendar: CalendarInfo) => {
      this.calendarMap.set(calendar.href, { ...calendar });
    },
    deleteCalendar: async (href: string) => {
      this.calendarMap.delete(href);
    },
  };

  readonly queue: SyncQueueStore = {
    enqueue: async (operation: Omit<SyncOperation, 'id'>) => {
      const id = this.nextQueueId++;
      this.queueList.push(cloneOperation({ ...operation, id }));
      return id;
    },
    list: async () => {
      return this.queueList.map(cloneOperation);
    },
    update: async (operation: SyncOperation) => {
      for (let i = 0; i < this.queueList.length; i++) {
        if (this.queueList[i].id === operation.id) {
          this.queueList[i] = cloneOperation(operation);
          return;
        }
      }
    },
    remove: async (id: number) => {
      for (let i = 0; i < this.queueList.length; i++) {
        if (this.queueList[i].id === id) {
          this.queueList.splice(i, 1);
          return;
        }
      }
    },
    clear: async () => {
      this.queueList.length = 0;
    },
  };
}
