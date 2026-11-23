import {
  CalDavError,
  createCalDavClient,
  createWebDavClient,
  resolveConfiguredCategories,
  toCompactTask,
} from "@tasker/core";
import { chunkTasksPayload, sortTasksByCategory } from "@tasker/core/watch";

function parseSettingValue(raw) {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof parsed.name === "string") {
      return parsed.name.trim();
    }
    if (typeof parsed === "string") {
      return parsed.trim();
    }
  } catch {
    // Fall through to raw string
  }
  return String(raw).trim();
}

function parseTimestampMs(isoOrMs) {
  if (typeof isoOrMs === "number") return isNaN(isoOrMs) ? null : isoOrMs;
  if (!isoOrMs) return null;
  const parsed = Date.parse(isoOrMs);
  return isNaN(parsed) ? null : parsed;
}

export function readCompanionCredentials(settingsStorage) {
  const baseUrl = parseSettingValue(settingsStorage.getItem("app_server"));
  const username = parseSettingValue(settingsStorage.getItem("app_username"));
  const appPassword = parseSettingValue(settingsStorage.getItem("app_password"));
  const calendarSetting = parseSettingValue(settingsStorage.getItem("app_calendar"));
  const configPath = parseSettingValue(settingsStorage.getItem("app_config_path"));

  if (!baseUrl || !username || !appPassword) {
    return null;
  }

  let calendarHref;
  if (calendarSetting) {
    if (calendarSetting.indexOf("/") !== -1) {
      calendarHref =
        calendarSetting.charAt(calendarSetting.length - 1) === "/"
          ? calendarSetting
          : `${calendarSetting}/`;
    } else {
      calendarHref = `/remote.php/dav/calendars/${encodeURIComponent(username)}/${encodeURIComponent(calendarSetting)}/`;
    }
  }

  return {
    baseUrl,
    username,
    appPassword,
    calendarHref,
    configPath: configPath || undefined,
  };
}

/**
 * Creates the Fitbit Companion CalDAV sync controller backed by `@tasker/core`.
 * Supports multi-list discovery (`FETCH_LISTS`), per-list task fetching (`FETCH_TASKS`),
 * and timestamp-aware lossless updates (`UPDATE_TASK`) where newer server changes win.
 */
export function createCompanionSync(options) {
  const { settingsStorage, send, fetch: fetchImpl, maxChunkBytes = 900 } = options;

  let activeCalendarHref = null;
  let categoryOrder = [];
  let cachedConfig = null;
  let cachedConfigDefaultHref;
  /** Map<calendarHref, Map<uid, Task>> */
  const cacheByCalendar = new Map();

  function getCalendarTaskCache(calendarHref) {
    let map = cacheByCalendar.get(calendarHref);
    if (!map) {
      map = new Map();
      cacheByCalendar.set(calendarHref, map);
    }
    return map;
  }

  function getClients() {
    const credentials = readCompanionCredentials(settingsStorage);
    if (!credentials) {
      return null;
    }
    const clientOpts = fetchImpl ? { fetch: fetchImpl } : undefined;
    return {
      credentials,
      caldav: createCalDavClient(credentials, clientOpts),
      webdav: createWebDavClient(credentials, clientOpts),
    };
  }

  async function loadRemoteConfig(clients) {
    cachedConfig = null;
    cachedConfigDefaultHref = undefined;
    if (!clients.credentials.configPath) return;
    try {
      const config = await clients.webdav.getJsonFile(clients.credentials.configPath);
      cachedConfig = config && typeof config === "object" ? config : null;
      const configured = resolveConfiguredCategories(config);
      if (configured) {
        categoryOrder = configured;
      }
      if (config && typeof config.defaultCalendarHref === "string") {
        cachedConfigDefaultHref = config.defaultCalendarHref;
      }
    } catch {
      // Non-fatal: missing config does not block sync
    }
  }

  async function resolveCalendarHref(clients, requestedHref) {
    if (requestedHref) return requestedHref;
    if (clients.credentials.calendarHref) return clients.credentials.calendarHref;
    if (cachedConfigDefaultHref) return cachedConfigDefaultHref;

    const calendars = await clients.caldav.listTaskCalendars();
    if (!calendars.length) {
      throw new Error("No VTODO task lists found.");
    }
    return calendars[0].href;
  }

  async function handleFetchLists() {
    const clients = getClients();
    if (!clients) {
      send({ type: "ERROR", message: "Set Nextcloud credentials in settings." });
      return;
    }

    try {
      await loadRemoteConfig(clients);
      const calendars = await clients.caldav.listTaskCalendars();
      const compactCalendars = calendars.map((c) => ({
        href: c.href,
        displayName: c.displayName,
      }));
      const defaultCalendarHref =
        clients.credentials.calendarHref || cachedConfigDefaultHref || undefined;

      send({
        type: "LISTS_PAYLOAD",
        calendars: compactCalendars,
        defaultCalendarHref,
        categoryOrder: categoryOrder.slice(),
      });
    } catch (error) {
      send({
        type: "ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleFetchTasks(requestedCalendarHref) {
    const clients = getClients();
    if (!clients) {
      send({ type: "ERROR", message: "Set Nextcloud credentials in settings." });
      return;
    }

    try {
      await loadRemoteConfig(clients);
      const calendarHref = await resolveCalendarHref(clients, requestedCalendarHref);
      activeCalendarHref = calendarHref;

      const tasks = await clients.caldav.fetchTasks(calendarHref);
      const calCache = getCalendarTaskCache(calendarHref);
      calCache.clear();
      for (let i = 0; i < tasks.length; i++) {
        calCache.set(tasks[i].uid, tasks[i]);
      }

      const listCategoryOrder =
        resolveConfiguredCategories(cachedConfig, calendarHref) || categoryOrder;

      const compact = sortTasksByCategory(
        tasks.map((t) => toCompactTask(t)),
        listCategoryOrder,
      );
      const messages = chunkTasksPayload(compact, {
        maxBytes: maxChunkBytes,
        calendarHref,
        categoryOrder: listCategoryOrder,
      });

      for (let i = 0; i < messages.length; i++) {
        send(messages[i]);
      }
    } catch (error) {
      send({
        type: "ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function handleUpdateTask(uid, completed, requestedCalendarHref, updatedAt) {
    const clients = getClients();
    if (!clients) {
      send({ type: "ERROR", message: "Set Nextcloud credentials in settings." });
      return;
    }

    try {
      const calendarHref =
        requestedCalendarHref ||
        activeCalendarHref ||
        (await resolveCalendarHref(clients));
      activeCalendarHref = calendarHref;

      const calCache = getCalendarTaskCache(calendarHref);
      let existing = calCache.get(uid);
      if (!existing) {
        const fetched = await clients.caldav.fetchTasks(calendarHref);
        calCache.clear();
        for (let i = 0; i < fetched.length; i++) {
          calCache.set(fetched[i].uid, fetched[i]);
        }
        existing = calCache.get(uid);
      }

      if (!existing) {
        send({ type: "ERROR", message: `Task ${uid} not found.` });
        return;
      }

      const localMs = parseTimestampMs(updatedAt);
      const isServerNewerOrEqual = (serverTask) => {
        if (localMs === null) return false;
        const serverMs = parseTimestampMs(serverTask.lastModified);
        return serverMs !== null && serverMs >= localMs;
      };

      const ackServerWinner = (serverTask) => {
        calCache.set(uid, serverTask);
        send({
          type: "UPDATE_ACK",
          uid,
          calendarHref,
          completed: serverTask.status === "COMPLETED",
          etag: serverTask.etag,
          lastModified: parseTimestampMs(serverTask.lastModified) ?? undefined,
        });
      };

      // If cached server copy is already newer than the watch toggle, server wins immediately
      if (isServerNewerOrEqual(existing)) {
        ackServerWinner(existing);
        return;
      }

      const writeTime = localMs !== null ? new Date(localMs) : new Date();
      const applyToggle = (baseTask) => {
        const iso = writeTime.toISOString();
        return {
          ...baseTask,
          status: completed ? "COMPLETED" : "NEEDS-ACTION",
          percentComplete: completed ? 100 : 0,
          completedAt: completed ? iso : undefined,
          lastModified: iso,
        };
      };

      let updated = applyToggle(existing);
      let putResult;
      try {
        putResult = await clients.caldav.putTask(calendarHref, updated, {
          ifMatch: existing.etag,
          now: writeTime,
        });
      } catch (err) {
        if (err instanceof CalDavError && err.code === "PRECONDITION_FAILED" && existing.href) {
          const fresh = await clients.caldav.getTask(existing.href, calendarHref);
          // Re-check timestamp against fresh server copy: newer server edit wins!
          if (isServerNewerOrEqual(fresh)) {
            ackServerWinner(fresh);
            return;
          }
          updated = applyToggle(fresh);
          putResult = await clients.caldav.putTask(calendarHref, updated, {
            ifMatch: fresh.etag,
            now: writeTime,
          });
        } else {
          throw err;
        }
      }

      calCache.set(uid, {
        ...updated,
        href: putResult.href,
        etag: putResult.etag,
        rawIcs: putResult.ics,
      });

      send({
        type: "UPDATE_ACK",
        uid,
        calendarHref,
        completed,
        etag: putResult.etag,
        lastModified: writeTime.getTime(),
      });
    } catch (error) {
      send({
        type: "ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function onMessage(data) {
    if (!data || typeof data !== "object") return;
    if (data.type === "FETCH_LISTS") {
      await handleFetchLists();
    } else if (data.type === "FETCH_TASKS") {
      await handleFetchTasks(data.calendarHref);
    } else if (data.type === "UPDATE_TASK") {
      await handleUpdateTask(data.uid, Boolean(data.completed), data.calendarHref, data.updatedAt);
    }
  }

  return {
    onMessage,
    handleFetchLists,
    handleFetchTasks,
    handleUpdateTask,
  };
}
