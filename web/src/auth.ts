import {
  CalDavError,
  createBasicAuthHeader as coreCreateBasicAuthHeader,
  createWebDavClient,
  resolveConfiguredCategories,
  type Credentials,
  type FetchLike,
  type TaskerConfig,
} from '@tasker/core';
import { getTaskerDb } from './db/index';
import {
  clearAllLocalData,
  loadCategoriesByCalendar,
  saveCategoriesByCalendar,
  saveCategoryOrder,
  saveTaskerConfig,
} from './db/storage';

const CREDENTIALS_KEY = 'default';

export type RemoteConfigResult =
  | { status: 'none' }
  | { status: 'loaded'; config: TaskerConfig }
  | { status: 'not_found'; path: string }
  | { status: 'error'; path: string; message: string };

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

async function applyRemoteConfigLocally(config: TaskerConfig): Promise<void> {
  await saveTaskerConfig(config);
  if (config.categoriesByCalendar && typeof config.categoriesByCalendar === 'object') {
    const existing = await loadCategoriesByCalendar();
    const merged: Record<string, string[]> = { ...existing };
    for (const [href, list] of Object.entries(config.categoriesByCalendar)) {
      if (Array.isArray(list)) {
        merged[href] = list.slice();
      }
    }
    await saveCategoriesByCalendar(merged);
  }
  const categories = resolveConfiguredCategories(config);
  if (categories && categories.length > 0) {
    await saveCategoryOrder(categories);
  }
}

/**
 * Fetches `tasker-config.json` from the user-configured WebDAV path when set,
 * distinguishing a missing file (`not_found` / HTTP 404) from other errors so
 * the UI can offer to create the config file.
 */
export async function fetchRemoteConfig(
  credentials: Credentials,
  fetchImpl?: FetchLike,
): Promise<RemoteConfigResult> {
  const configPath = credentials.configPath?.trim();
  if (!configPath) return { status: 'none' };

  try {
    const webdav = createWebDavClient(credentials, fetchImpl ? { fetch: fetchImpl } : undefined);
    const config = await webdav.getJsonFile<TaskerConfig>(configPath);
    await applyRemoteConfigLocally(config);
    return { status: 'loaded', config };
  } catch (error) {
    if (error instanceof CalDavError && error.code === 'NOT_FOUND') {
      return { status: 'not_found', path: configPath };
    }
    return {
      status: 'error',
      path: configPath,
      message: error instanceof Error ? error.message : 'Failed to load config file',
    };
  }
}

/**
 * Creates a new `tasker-config.json` on the user's Nextcloud WebDAV server
 * (creating parent directories if needed) and persists it to IndexedDB.
 */
export async function createRemoteConfig(
  credentials: Credentials,
  config: TaskerConfig,
  fetchImpl?: FetchLike,
): Promise<TaskerConfig> {
  const configPath = credentials.configPath?.trim();
  if (!configPath) {
    throw new Error('Config JSON path is not set.');
  }

  const webdav = createWebDavClient(credentials, fetchImpl ? { fetch: fetchImpl } : undefined);
  await webdav.putJsonFile(configPath, config, { createParents: true });
  await applyRemoteConfigLocally(config);
  return config;
}

/**
 * Fetches `tasker-config.json` from the user-configured WebDAV path when set,
 * persisting discovered category order and preferences to IndexedDB.
 */
export async function bootstrapRemoteConfig(
  credentials: Credentials,
  fetchImpl?: FetchLike,
): Promise<TaskerConfig | undefined> {
  const result = await fetchRemoteConfig(credentials, fetchImpl);
  return result.status === 'loaded' ? result.config : undefined;
}
