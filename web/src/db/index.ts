import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { CalendarInfo, Credentials, SyncOperation, Task, TaskerConfig } from '@tasker/core';

export const DB_NAME = 'tasker-db';
export const DB_VERSION = 2;

export interface TaskerDBSchema extends DBSchema {
  credentials: {
    key: string;
    value: Credentials;
  };
  tasks: {
    key: string;
    value: Task;
    indexes: {
      'by-calendar': string;
      'by-status': string;
    };
  };
  calendars: {
    key: string;
    value: CalendarInfo;
  };
  'sync-queue': {
    key: number;
    value: SyncOperation;
  };
  settings: {
    key: string;
    value: string[] | TaskerConfig | boolean;
  };
}

let dbPromise: Promise<IDBPDatabase<TaskerDBSchema>> | null = null;

export function getTaskerDb(): Promise<IDBPDatabase<TaskerDBSchema>> {
  if (!dbPromise) {
    dbPromise = openDB<TaskerDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('credentials')) {
          db.createObjectStore('credentials');
        }
        if (!db.objectStoreNames.contains('tasks')) {
          const taskStore = db.createObjectStore('tasks', { keyPath: 'uid' });
          taskStore.createIndex('by-calendar', 'calendarHref');
          taskStore.createIndex('by-status', 'status');
        }
        if (!db.objectStoreNames.contains('calendars')) {
          db.createObjectStore('calendars', { keyPath: 'href' });
        }
        if (!db.objectStoreNames.contains('sync-queue')) {
          db.createObjectStore('sync-queue', { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings');
        }
      },
    });
  }
  return dbPromise;
}

export async function resetTaskerDbConnection(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise;
    db.close();
    dbPromise = null;
  }
}
