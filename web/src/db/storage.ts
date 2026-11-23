import type {
  CalendarInfo,
  CalendarMetadataStore,
  SyncOperation,
  SyncQueueStore,
  SyncStorage,
  Task,
  TaskerConfig,
  TaskStore,
} from '@tasker/core';
import { getTaskerDb } from './index';

const CATEGORIES_KEY = 'categories';
const LEGACY_AISLES_KEY = 'aisles';
const CONFIG_KEY = 'config';
const AUTO_CATEGORIZE_KEY = 'autoCategorize';

export const DEFAULT_CATEGORIES: string[] = [
  'Produce',
  'Bakery',
  'Deli & Meat',
  'Dairy',
  'Pantry',
  'Frozen',
  'Household',
];

/**
 * IndexedDB adapter implementing `@tasker/core`'s `SyncStorage` interfaces.
 */
export class IndexedDbSyncStorage implements SyncStorage {
  readonly tasks: TaskStore = {
    getTask: async (uid: string): Promise<Task | undefined> => {
      const db = await getTaskerDb();
      return db.get('tasks', uid);
    },
    getTasksByCalendar: async (calendarHref: string): Promise<Task[]> => {
      const db = await getTaskerDb();
      return db.getAllFromIndex('tasks', 'by-calendar', calendarHref);
    },
    putTask: async (task: Task): Promise<void> => {
      const db = await getTaskerDb();
      await db.put('tasks', task);
    },
    deleteTask: async (uid: string): Promise<void> => {
      const db = await getTaskerDb();
      await db.delete('tasks', uid);
    },
  };

  readonly calendars: CalendarMetadataStore = {
    getCalendar: async (href: string): Promise<CalendarInfo | undefined> => {
      const db = await getTaskerDb();
      return db.get('calendars', href);
    },
    getAllCalendars: async (): Promise<CalendarInfo[]> => {
      const db = await getTaskerDb();
      return db.getAll('calendars');
    },
    putCalendar: async (calendar: CalendarInfo): Promise<void> => {
      const db = await getTaskerDb();
      await db.put('calendars', calendar);
    },
    deleteCalendar: async (href: string): Promise<void> => {
      const db = await getTaskerDb();
      await db.delete('calendars', href);
    },
  };

  readonly queue: SyncQueueStore = {
    enqueue: async (operation: Omit<SyncOperation, 'id'>): Promise<number> => {
      const db = await getTaskerDb();
      return db.add('sync-queue', operation as SyncOperation);
    },
    list: async (): Promise<SyncOperation[]> => {
      const db = await getTaskerDb();
      return db.getAll('sync-queue');
    },
    update: async (operation: SyncOperation): Promise<void> => {
      const db = await getTaskerDb();
      await db.put('sync-queue', operation);
    },
    remove: async (id: number): Promise<void> => {
      const db = await getTaskerDb();
      await db.delete('sync-queue', id);
    },
    clear: async (): Promise<void> => {
      const db = await getTaskerDb();
      await db.clear('sync-queue');
    },
  };
}

export async function loadCategoryOrder(): Promise<string[]> {
  const db = await getTaskerDb();
  const stored = await db.get('settings', CATEGORIES_KEY);
  if (Array.isArray(stored)) return stored;
  const legacy = await db.get('settings', LEGACY_AISLES_KEY);
  if (Array.isArray(legacy)) return legacy;
  return DEFAULT_CATEGORIES.slice();
}

export async function saveCategoryOrder(categories: string[]): Promise<void> {
  const db = await getTaskerDb();
  await db.put('settings', categories.slice(), CATEGORIES_KEY);
}

export async function loadAutoCategorize(): Promise<boolean> {
  const db = await getTaskerDb();
  const stored = await db.get('settings', AUTO_CATEGORIZE_KEY);
  return stored === true;
}

export async function saveAutoCategorize(enabled: boolean): Promise<void> {
  const db = await getTaskerDb();
  await db.put('settings', enabled, AUTO_CATEGORIZE_KEY);
}

export async function loadTaskerConfig(): Promise<TaskerConfig | undefined> {
  const db = await getTaskerDb();
  const stored = await db.get('settings', CONFIG_KEY);
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    return stored;
  }
  return undefined;
}

export async function saveTaskerConfig(config: TaskerConfig): Promise<void> {
  const db = await getTaskerDb();
  await db.put('settings', { ...config }, CONFIG_KEY);
}

/**
 * Clears all local credentials, cached tasks, calendars, sync queue, and settings.
 */
export async function clearAllLocalData(): Promise<void> {
  const db = await getTaskerDb();
  const tx = db.transaction(
    ['credentials', 'tasks', 'calendars', 'sync-queue', 'settings'],
    'readwrite',
  );
  await Promise.all([
    tx.objectStore('credentials').clear(),
    tx.objectStore('tasks').clear(),
    tx.objectStore('calendars').clear(),
    tx.objectStore('sync-queue').clear(),
    tx.objectStore('settings').clear(),
    tx.done,
  ]);
}
