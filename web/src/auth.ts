import {
  createBasicAuthHeader as coreCreateBasicAuthHeader,
  createWebDavClient,
  type Credentials,
  type FetchLike,
  type TaskerConfig,
} from '@tasker/core';
import { getTaskerDb } from './db/index';
import { clearAllLocalData, saveAisleOrder, saveTaskerConfig } from './db/storage';

const CREDENTIALS_KEY = 'default';

export function createBasicAuthHeader({ username, appPassword }: Credentials): string {
  return coreCreateBasicAuthHeader(username, appPassword);
}

export async function saveCredentials(credentials: Credentials): Promise<void> {
  const db = await getTaskerDb();
  await db.put('credentials', credentials, CREDENTIALS_KEY);
}

export async function loadCredentials(): Promise<Credentials | undefined> {
  const db = await getTaskerDb();
  return db.get('credentials', CREDENTIALS_KEY);
}

export async function clearCredentials(): Promise<void> {
  await clearAllLocalData();
}

/**
 * Fetches `tasker-config.json` from the user-configured WebDAV path when set,
 * persisting discovered aisle order and preferences to IndexedDB.
 */
export async function bootstrapRemoteConfig(
  credentials: Credentials,
  fetchImpl?: FetchLike,
): Promise<TaskerConfig | undefined> {
  const configPath = credentials.configPath?.trim();
  if (!configPath) return undefined;

  try {
    const webdav = createWebDavClient(credentials, fetchImpl ? { fetch: fetchImpl } : undefined);
    const config = await webdav.getJsonFile<TaskerConfig>(configPath);
    await saveTaskerConfig(config);
    if (Array.isArray(config.aisles) && config.aisles.length > 0) {
      await saveAisleOrder(config.aisles);
    }
    return config;
  } catch {
    // Missing or unreadable remote config is non-fatal during initial setup
    return undefined;
  }
}
