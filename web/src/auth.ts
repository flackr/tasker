import { openDB } from 'idb';
import type { Credentials } from './types';

const DB_NAME = 'tasker-db';
const STORE_NAME = 'credentials';
const KEY = 'default';

async function getDb() {
  return openDB(DB_NAME, 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    },
  });
}

export function createBasicAuthHeader({ username, appPassword }: Credentials): string {
  return `Basic ${btoa(`${username}:${appPassword}`)}`;
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  const db = await getDb();
  await db.put(STORE_NAME, credentials, KEY);
}

export async function loadCredentials(): Promise<Credentials | undefined> {
  const db = await getDb();
  return db.get(STORE_NAME, KEY);
}

export async function clearCredentials(): Promise<void> {
  const db = await getDb();
  await db.delete(STORE_NAME, KEY);
}
