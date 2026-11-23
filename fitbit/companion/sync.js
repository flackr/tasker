import {
  CalDavError,
  createCalDavClient,
  createWebDavClient,
  toCompactTask,
} from "@tasker/core";
import { chunkTasksPayload, sortTasksByAisle } from "@tasker/core/watch";

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
      calendarHref = calendarSetting.charAt(calendarSetting.length - 1) === "/"
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
 * Accepts injected `settingsStorage`, `send`, and optional `fetch` so the exact
 * same code runs on the smartphone Companion, in Vitest, and in Playwright E2E.
 */
export function createCompanionSync(options) {
  const { settingsStorage, send, fetch: fetchImpl, maxChunkBytes = 900 } = options;

  let activeCalendarHref = null;
  let aisleOrder = [];
  const taskCache = new Map();

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

  async function resolveCalendarHref(clients, requestedHref) {
    if (requestedHref) return requestedHref;
    if (clients.credentials.calendarHref) return clients.credentials.calendarHref;

    if (clients.credentials.configPath) {
      try {
        const config = await clients.webdav.getJsonFile(clients.credentials.configPath);
        if (config && Array.isArray(config.aisles)) {
          aisleOrder = config.aisles.slice();
        }
        if (config && config.defaultCalendarHref) {
          return config.defaultCalendarHref;
        }
      } catch {
        // Non-fatal: continue to calendar discovery
      }
    }

    const calendars = await clients.caldav.listTaskCalendars();
    if (!calendars.length) {
      throw new Error("No VTODO task lists found.");
    }
    return calendars[0].href;
  }

  async function loadAisleConfig(clients) {
    if (!clients.credentials.configPath) return;
    try {
      const config = await clients.webdav.getJsonFile(clients.credentials.configPath);
      if (config && Array.isArray(config.aisles)) {
        aisleOrder = config.aisles.slice();
      }
    } catch {
      // Ignore missing remote config
    }
  }

  async function handleFetchTasks(requestedCalendarHref) {
    const clients = getClients();
    if (!clients) {
      send({ type: "ERROR", message: "Set Nextcloud credentials in settings." });
      return;
    }

    try {
      await loadAisleConfig(clients);
      const calendarHref = await resolveCalendarHref(clients, requestedCalendarHref);
      activeCalendarHref = calendarHref;

      const tasks = await clients.caldav.fetchTasks(calendarHref);
      taskCache.clear();
      for (let i = 0; i < tasks.length; i++) {
        taskCache.set(tasks[i].uid, tasks[i]);
      }

      const compact = sortTasksByAisle(
        tasks.map((t) => toCompactTask(t)),
        aisleOrder,
      );
      const messages = chunkTasksPayload(compact, {
        maxBytes: maxChunkBytes,
        calendarHref,
        aisleOrder,
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

  async function handleUpdateTask(uid, completed, requestedCalendarHref) {
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

      let existing = taskCache.get(uid);
      if (!existing) {
        const fetched = await clients.caldav.fetchTasks(calendarHref);
        taskCache.clear();
        for (let i = 0; i < fetched.length; i++) {
          taskCache.set(fetched[i].uid, fetched[i]);
        }
        existing = taskCache.get(uid);
      }

      if (!existing) {
        send({ type: "ERROR", message: `Task ${uid} not found.` });
        return;
      }

      const applyToggle = (baseTask) => {
        const nowIso = new Date().toISOString();
        return {
          ...baseTask,
          status: completed ? "COMPLETED" : "NEEDS-ACTION",
          percentComplete: completed ? 100 : 0,
          completedAt: completed ? nowIso : undefined,
          lastModified: nowIso,
        };
      };

      let updated = applyToggle(existing);
      let putResult;
      try {
        putResult = await clients.caldav.putTask(calendarHref, updated, {
          ifMatch: existing.etag,
        });
      } catch (err) {
        if (err instanceof CalDavError && err.code === "PRECONDITION_FAILED" && existing.href) {
          // Refresh latest server copy and re-apply the user's watch toggle losslessly
          const fresh = await clients.caldav.getTask(existing.href, calendarHref);
          updated = applyToggle(fresh);
          putResult = await clients.caldav.putTask(calendarHref, updated, {
            ifMatch: fresh.etag,
          });
        } else {
          throw err;
        }
      }

      taskCache.set(uid, {
        ...updated,
        href: putResult.href,
        etag: putResult.etag,
        rawIcs: putResult.ics,
      });

      send({ type: "UPDATE_ACK", uid, etag: putResult.etag });
    } catch (error) {
      send({
        type: "ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function onMessage(data) {
    if (!data || typeof data !== "object") return;
    if (data.type === "FETCH_TASKS") {
      await handleFetchTasks(data.calendarHref);
    } else if (data.type === "UPDATE_TASK") {
      await handleUpdateTask(data.uid, Boolean(data.completed), data.calendarHref);
    }
  }

  return {
    onMessage,
    handleFetchTasks,
    handleUpdateTask,
  };
}
