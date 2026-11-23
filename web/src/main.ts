import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
import './style.css';
import {
  createCalDavClient,
  createWebDavClient,
  SyncEngine,
  type CalendarInfo,
  type Credentials,
  type SyncConflict,
  type Task,
} from '@tasker/core';
import {
  categorizeUncategorizedTasks,
  checkPromptApiAvailability,
  isPromptApiUsable,
  type PromptApiAvailability,
} from './ai/categorizer';
import {
  clearCredentials,
  createRemoteConfig,
  fetchRemoteConfig,
  loadCredentials,
  saveCredentials,
} from './auth';
import {
  IndexedDbSyncStorage,
  loadAutoCategorize,
  loadCategoryOrder,
  loadTaskerConfig,
  saveAutoCategorize,
  saveCategoryOrder,
  saveTaskerConfig,
} from './db/storage';
import { registerServiceWorker, requestBackgroundFlush } from './sw-register';
import { escapeAttr, escapeHtml } from './ui/html';
import { renderCategoryManager } from './ui/category-manager';
import { renderAddTaskModal, renderListView } from './ui/list-view';
import { renderSettingsView } from './ui/settings-view';
import { renderTaskEditor } from './ui/task-editor';

type ActiveTab = 'list' | 'categories' | 'settings';
type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error' | 'offline';

interface AppState {
  tab: ActiveTab;
  credentials?: Credentials;
  calendars: CalendarInfo[];
  tasks: Task[];
  categoryOrder: string[];
  pendingCount: number;
  conflicts: SyncConflict[];
  statusMessage: string;
  connectionState: ConnectionState;
  isOnline: boolean;
  hideCompleted: boolean;
  focusedUid: string | null;
  editingUid: string | null;
  confirmingDelete: boolean;
  renamingCategoryIndex: number | null;
  autoCategorize: boolean;
  promptApiAvailability: PromptApiAvailability;
  autoCategorizeProgress: string | null;
  missingConfigPath: string | null;
  creatingConfig: boolean;
  drawerOpen: boolean;
  addingTask: boolean;
}

const appRoot = document.querySelector<HTMLDivElement>('#app');
if (!appRoot) throw new Error('App root not found');

const storage = new IndexedDbSyncStorage();
let syncEngine: SyncEngine | null = null;
let syncInFlight = false;
let syncQueued = false;
let syncQueuedForce = false;
let autoCategorizeAbort: AbortController | null = null;
let categoryWriteChain: Promise<void> = Promise.resolve();
const attemptedAutoCategorizeUids = new Set<string>();

const state: AppState = {
  tab: 'settings',
  calendars: [],
  tasks: [],
  categoryOrder: [],
  pendingCount: 0,
  conflicts: [],
  statusMessage: 'Enter your Nextcloud credentials to load tasks.',
  connectionState: 'idle',
  isOnline: typeof navigator !== 'undefined' ? navigator.onLine : true,
  hideCompleted: false,
  focusedUid: null,
  editingUid: null,
  confirmingDelete: false,
  renamingCategoryIndex: null,
  autoCategorize: false,
  promptApiAvailability: 'unsupported',
  autoCategorizeProgress: null,
  missingConfigPath: null,
  creatingConfig: false,
  drawerOpen: false,
  addingTask: false,
};

function createEngine(credentials: Credentials): SyncEngine {
  const client = createCalDavClient(credentials);
  return new SyncEngine(client, storage);
}

async function refreshLocalState(): Promise<void> {
  state.categoryOrder = await loadCategoryOrder(state.credentials?.calendarHref);
  state.autoCategorize = await loadAutoCategorize();
  state.calendars = await storage.calendars.getAllCalendars();
  state.pendingCount = (await storage.queue.list()).length;
  if (state.credentials?.calendarHref) {
    state.tasks = await storage.tasks.getTasksByCalendar(state.credentials.calendarHref);
  } else {
    state.tasks = [];
  }
}

async function switchCalendar(
  calendarHref: string,
  options: { forceSync?: boolean; openListTab?: boolean } = {},
): Promise<void> {
  if (!state.credentials || !calendarHref) return;
  autoCategorizeAbort?.abort();
  autoCategorizeAbort = null;
  state.autoCategorizeProgress = null;
  attemptedAutoCategorizeUids.clear();
  state.drawerOpen = false;
  state.addingTask = false;
  state.focusedUid = null;
  state.editingUid = null;
  state.confirmingDelete = false;
  state.renamingCategoryIndex = null;
  state.conflicts = [];

  const updatedCreds: Credentials = { ...state.credentials, calendarHref };
  state.credentials = updatedCreds;
  await saveCredentials(updatedCreds);
  syncEngine = createEngine(updatedCreds);
  await refreshLocalState();

  if (options.openListTab || state.tab === 'settings') {
    state.tab = 'list';
  }
  state.statusMessage = state.isOnline
    ? state.tasks.length > 0
      ? `Loaded ${state.tasks.length} cached task(s). Syncing…`
      : 'Loading tasks…'
    : `Offline — showing ${state.tasks.length} cached task(s).`;
  render();

  if (navigator.onLine) {
    await runSync({ force: Boolean(options.forceSync) || state.tasks.length === 0 });
  }
}

async function bootstrap(): Promise<void> {
  state.isOnline = navigator.onLine;
  state.credentials = await loadCredentials();
  state.promptApiAvailability = await checkPromptApiAvailability();
  await refreshLocalState();

  if (state.credentials) {
    syncEngine = createEngine(state.credentials);
    if (state.credentials.calendarHref) {
      state.tab = 'list';
      state.statusMessage = state.isOnline
        ? `Loaded ${state.tasks.length} cached task(s). Syncing…`
        : `Offline — showing ${state.tasks.length} cached task(s).`;
      state.connectionState = state.isOnline ? 'connecting' : 'offline';
      render();
      if (state.isOnline) {
        await runSync({ force: false });
      }
    } else {
      state.tab = 'settings';
      render();
      if (state.isOnline) {
        await discoverCalendars(state.credentials);
      }
    }
  } else {
    render();
  }

  window.addEventListener('online', () => {
    state.isOnline = true;
    render();
    if (state.credentials?.calendarHref) {
      void runSync({ force: false });
    }
  });

  window.addEventListener('offline', () => {
    state.isOnline = false;
    state.connectionState = 'offline';
    state.statusMessage = 'Offline — changes will sync automatically when reconnected.';
    render();
  });

  document.addEventListener('visibilitychange', () => {
    if (
      document.visibilityState === 'visible' &&
      navigator.onLine &&
      state.credentials?.calendarHref
    ) {
      void runSync({ force: false });
    }
  });

  document.addEventListener('click', (event) => {
    if (!state.focusedUid) return;
    const target = event.target as Node | null;
    const focusedRow = appRoot!.querySelector(
      `[data-task-uid="${CSS.escape(state.focusedUid)}"]`,
    );
    if (focusedRow && target && !focusedRow.contains(target)) {
      void commitInlineEditAndBlur();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (state.addingTask) {
      state.addingTask = false;
      render();
    } else if (state.drawerOpen) {
      state.drawerOpen = false;
      render();
    } else if (state.focusedUid) {
      state.focusedUid = null;
      render();
    }
  });

  registerServiceWorker(() => {
    if (state.credentials?.calendarHref) {
      void runSync({ force: false });
    }
  });
}

async function discoverCalendars(credentials: Credentials): Promise<void> {
  state.connectionState = 'connecting';
  state.statusMessage = 'Connecting…';
  state.missingConfigPath = null;
  state.creatingConfig = false;
  render();

  try {
    const configResult = await fetchRemoteConfig(credentials);
    const remoteConfig = configResult.status === 'loaded' ? configResult.config : undefined;
    state.missingConfigPath = configResult.status === 'not_found' ? configResult.path : null;

    const client = createCalDavClient(credentials);
    const calendars = await client.listTaskCalendars();

    for (const cal of calendars) {
      // Preserve previously synced ctag only; do not stamp remote ctag before tasks are fetched
      const existing = await storage.calendars.getCalendar(cal.href);
      await storage.calendars.putCalendar({
        href: cal.href,
        displayName: cal.displayName,
        ...(existing?.ctag ? { ctag: existing.ctag } : {}),
      });
    }

    state.calendars = calendars;
    state.categoryOrder = await loadCategoryOrder(credentials.calendarHref);

    if (calendars.length === 0) {
      state.connectionState = 'connected';
      state.statusMessage = state.missingConfigPath
        ? `Connected, no VTODO task lists found. Config file "${state.missingConfigPath}" does not exist yet.`
        : 'Connected, but no VTODO task lists were found.';
      render();
      return;
    }

    const preferredHref = credentials.calendarHref || remoteConfig?.defaultCalendarHref;
    const matched = preferredHref && calendars.some((c) => c.href === preferredHref);

    if (matched && preferredHref && !state.missingConfigPath) {
      await switchCalendar(preferredHref, { forceSync: true, openListTab: true });
    } else {
      state.connectionState = 'connected';
      state.statusMessage = state.missingConfigPath
        ? `Connected as ${credentials.username}. Config file "${state.missingConfigPath}" was not found — create it below or select a task list.`
        : `Connected as ${credentials.username}. Select a task list to load.`;
      render();
    }
  } catch (error) {
    state.connectionState = 'error';
    state.statusMessage = error instanceof Error ? error.message : 'Connection failed';
    render();
  }
}

async function runSync(options: { force?: boolean } = {}): Promise<void> {
  if (!state.credentials?.calendarHref || !syncEngine) return;

  if (syncInFlight) {
    syncQueued = true;
    if (options.force) syncQueuedForce = true;
    return;
  }

  if (!navigator.onLine) {
    state.isOnline = false;
    state.connectionState = 'offline';
    state.statusMessage = `Offline — ${state.pendingCount} pending change(s).`;
    render();
    return;
  }

  syncInFlight = true;
  state.connectionState = 'connecting';
  render();

  try {
    // Wait for any in-flight local category write before pulling remote config
    await categoryWriteChain;
    if (state.credentials.configPath) {
      await fetchRemoteConfig(state.credentials);
    }
    const result = await syncEngine.fullSync(state.credentials.calendarHref, {
      force: options.force,
      conflictStrategy: 'manual',
    });
    state.conflicts = result.flush.conflicts;
    await refreshLocalState();
    state.connectionState = 'connected';
    state.statusMessage =
      state.conflicts.length > 0
        ? `Connected to ${state.credentials.username}. ${state.conflicts.length} conflict(s) need attention.`
        : `Connected to ${state.credentials.username}. Loaded ${state.tasks.length} tasks.`;
  } catch (error) {
    await refreshLocalState();
    if (!navigator.onLine) {
      state.isOnline = false;
      state.connectionState = 'offline';
      state.statusMessage = `Offline — ${state.pendingCount} pending change(s).`;
    } else {
      state.connectionState = 'error';
      state.statusMessage = error instanceof Error ? error.message : 'Sync failed';
    }
  } finally {
    syncInFlight = false;
    render();
  }

  if (syncQueued) {
    const nextForce = syncQueuedForce;
    syncQueued = false;
    syncQueuedForce = false;
    await runSync({ force: nextForce });
    return;
  }

  if (state.autoCategorize && state.tab === 'list') {
    void maybeAutoCategorize(false);
  }
}

async function flushOrScheduleSync(): Promise<void> {
  await refreshLocalState();
  render();

  if (!navigator.onLine) {
    state.isOnline = false;
    state.connectionState = 'offline';
    state.statusMessage = `Saved offline (${state.pendingCount} pending).`;
    render();
    await requestBackgroundFlush();
    return;
  }

  await runSync({ force: false });
}

async function maybeAutoCategorize(manualTrigger: boolean): Promise<void> {
  if (autoCategorizeAbort || !syncEngine || !state.credentials?.calendarHref) return;
  if (!isPromptApiUsable(state.promptApiAvailability) || state.categoryOrder.length === 0) return;

  if (manualTrigger) {
    attemptedAutoCategorizeUids.clear();
  }

  const candidates = state.tasks.filter(
    (t) => t.categories.length === 0 && !attemptedAutoCategorizeUids.has(t.uid),
  );
  if (candidates.length === 0) return;

  const controller = new AbortController();
  autoCategorizeAbort = controller;
  state.autoCategorizeProgress = `Starting on-device AI for ${candidates.length} item(s)…`;
  render();

  let assignedCount = 0;

  try {
    const result = await categorizeUncategorizedTasks(candidates, state.categoryOrder, {
      signal: controller.signal,
      callbacks: {
        onDownloadProgress(fraction) {
          state.autoCategorizeProgress = `Downloading local AI model (${Math.round(fraction * 100)}%)…`;
          render();
        },
        onStepStart(task, index, total) {
          state.autoCategorizeProgress = `Auto-categorizing ${index + 1}/${total}: "${task.summary}"…`;
          render();
        },
        async onTaskCategorized(task, category) {
          attemptedAutoCategorizeUids.add(task.uid);
          if (category && syncEngine) {
            const latest = (await storage.tasks.getTask(task.uid)) ?? task;
            await syncEngine.updateTask({ ...latest, categories: [category] });
            assignedCount += 1;
            await refreshLocalState();
            render();
          }
        },
      },
    });

    state.autoCategorizeProgress = null;
    autoCategorizeAbort = null;

    if (assignedCount > 0) {
      await flushOrScheduleSync();
    } else if (result.cancelled) {
      state.statusMessage = 'Auto-categorize stopped.';
      render();
    } else {
      render();
    }
  } catch (error) {
    state.autoCategorizeProgress = null;
    autoCategorizeAbort = null;
    state.statusMessage =
      error instanceof Error ? `Auto-categorize failed: ${error.message}` : 'Auto-categorize failed';
    render();
  }
}

async function persistCategories(categories: string[]): Promise<void> {
  const calendarHref = state.credentials?.calendarHref;
  const credentials = state.credentials;
  const snapshot = categories.slice();
  state.categoryOrder = snapshot;
  attemptedAutoCategorizeUids.clear();
  render();
  await saveCategoryOrder(snapshot, calendarHref);

  if (credentials?.configPath && navigator.onLine) {
    const configPath = credentials.configPath;
    categoryWriteChain = categoryWriteChain.then(async () => {
      try {
        const webdav = createWebDavClient(credentials);
        let baseConfig = (await loadTaskerConfig()) ?? {};
        try {
          const remote = await webdav.getJsonFile<Record<string, unknown>>(configPath);
          if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
            baseConfig = { ...baseConfig, ...remote };
          }
        } catch {
          // Remote file may not exist yet or be temporarily unreachable; merge on local copy
        }
        const nextConfig = calendarHref
          ? {
              ...baseConfig,
              categoriesByCalendar: {
                ...(baseConfig.categoriesByCalendar ?? {}),
                [calendarHref]: snapshot,
              },
            }
          : { ...baseConfig, categories: snapshot };
        delete nextConfig.aisles;
        await saveTaskerConfig(nextConfig);
        await webdav.putJsonFile(configPath, nextConfig, { createParents: true });
      } catch {
        // Local category update still succeeds if remote config write fails
      }
    });
    await categoryWriteChain;
  }
}

async function commitInlineEdit(uid: string): Promise<void> {
  if (!syncEngine) return;
  const input = appRoot!.querySelector<HTMLInputElement>(
    `input[data-inline-uid="${CSS.escape(uid)}"]`,
  );
  if (!input) return;
  const nextSummary = input.value.trim();
  const existing = state.tasks.find((t) => t.uid === uid);
  if (!existing || !nextSummary || nextSummary === existing.summary) return;
  await syncEngine.updateTask({ ...existing, summary: nextSummary });
  await flushOrScheduleSync();
}

async function commitInlineEditAndBlur(): Promise<void> {
  const uid = state.focusedUid;
  if (!uid) return;
  state.focusedUid = null;
  await commitInlineEdit(uid);
  render();
}

function getActiveCalendarName(): string | undefined {
  if (!state.credentials?.calendarHref) return undefined;
  return state.calendars.find((c) => c.href === state.credentials?.calendarHref)?.displayName;
}

function renderHeaderTitle(hasCalendar: boolean): string {
  const activeName = getActiveCalendarName();
  const title =
    state.tab === 'list' && hasCalendar
      ? activeName || 'Task List'
      : state.tab === 'categories'
        ? activeName
          ? `${activeName} · Categories`
          : 'Categories'
        : hasCalendar
          ? 'Settings'
          : 'tasker';

  if (hasCalendar) {
    return `
      <button
        type="button"
        id="header-title-btn"
        class="header-title-btn"
        data-testid="header-title"
        aria-label="Switch list or open menu"
      >
        <h1 class="header-title">${escapeHtml(title)}</h1>
      </button>
    `;
  }

  return `<h1 class="header-title" data-testid="header-title">${escapeHtml(title)}</h1>`;
}

function renderHeaderStatus(hasCalendar: boolean): string {
  if (!hasCalendar) return '';

  const label =
    state.connectionState === 'connecting'
      ? 'Syncing…'
      : state.connectionState === 'offline' || !state.isOnline
        ? 'Offline'
        : state.connectionState === 'error'
          ? 'Sync error'
          : 'Synced';

  const pillClass = `status-pill status-pill-${!state.isOnline ? 'offline' : state.connectionState}`;
  const canSync = state.isOnline && state.connectionState !== 'connecting';

  return `
    <button
      type="button"
      id="sync-now-btn"
      class="${pillClass}"
      data-testid="sync-now"
      title="${escapeAttr(state.statusMessage)}"
      ${canSync ? '' : 'disabled'}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M13.5 8A5.5 5.5 0 1 1 11.9 4.1M13.5 2.5V5.5H10.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span data-testid="header-status">${label}</span>
    </button>
  `;
}

function renderNavDrawer(hasCalendar: boolean): string {
  const activeHref = state.credentials?.calendarHref;
  const activeName = getActiveCalendarName();

  const calendarItems = state.calendars
    .map((cal) => {
      const isActive = state.tab === 'list' && cal.href === activeHref;
      const isSelected = cal.href === activeHref;
      return `
        <button
          type="button"
          class="drawer-item ${isActive ? 'active' : ''}"
          data-switch-calendar="${escapeAttr(cal.href)}"
          data-testid="list-option-${escapeAttr(cal.displayName)}"
          aria-current="${isSelected ? 'true' : 'false'}"
        >
          <span>${escapeHtml(cal.displayName)}</span>
          ${
            isSelected
              ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5L6.5 12L13 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
              : ''
          }
        </button>`;
    })
    .join('');

  return `
    <div class="drawer-backdrop" id="drawer-backdrop" data-testid="drawer-backdrop">
      <aside class="nav-drawer" role="dialog" aria-modal="true" aria-label="Navigation menu" data-testid="nav-drawer">
        <div class="drawer-header">
          <span class="drawer-brand">tasker</span>
          <button type="button" id="drawer-close-btn" class="menu-btn" aria-label="Close menu">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M4.5 4.5L13.5 13.5M13.5 4.5L4.5 13.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        ${
          state.calendars.length > 0
            ? `
          <div class="drawer-section">
            <div class="drawer-section-label">Task Lists</div>
            ${calendarItems}
          </div>`
            : ''
        }

        <div class="drawer-section">
          <div class="drawer-section-label">Manage</div>
          <button
            type="button"
            class="drawer-item ${state.tab === 'categories' ? 'active' : ''}"
            data-tab="categories"
            data-testid="nav-categories"
          >
            <span>Categories</span>
            ${activeName ? `<span class="drawer-item-meta">${escapeHtml(activeName)}</span>` : ''}
          </button>
          <button
            type="button"
            class="drawer-item ${state.tab === 'settings' ? 'active' : ''}"
            data-tab="settings"
            data-testid="nav-settings"
          >
            <span>Settings</span>
            ${hasCalendar ? '' : '<span class="drawer-item-meta">Setup</span>'}
          </button>
        </div>
      </aside>
    </div>
  `;
}

function render(): void {
  const hasCalendar = Boolean(state.credentials?.calendarHref);
  const editingTask = state.editingUid
    ? state.tasks.find((t) => t.uid === state.editingUid)
    : undefined;

  const mainContent =
    state.tab === 'list' && hasCalendar
      ? renderListView({
          tasks: state.tasks,
          categoryOrder: state.categoryOrder,
          conflicts: state.conflicts,
          hideCompleted: state.hideCompleted,
          focusedUid: state.focusedUid,
          promptApiAvailability: state.promptApiAvailability,
          autoCategorizeProgress: state.autoCategorizeProgress,
        })
      : state.tab === 'categories'
        ? renderCategoryManager({
            categories: state.categoryOrder,
            renamingIndex: state.renamingCategoryIndex,
            calendarName: getActiveCalendarName(),
          })
        : renderSettingsView({
            credentials: state.credentials,
            calendars: state.calendars,
            connectionStatus: state.statusMessage,
            connectionState: state.connectionState,
            autoCategorize: state.autoCategorize,
            promptApiAvailability: state.promptApiAvailability,
            missingConfigPath: state.missingConfigPath,
            creatingConfig: state.creatingConfig,
          });

  appRoot!.innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        <div class="header-left">
          <button
            type="button"
            id="menu-toggle-btn"
            class="menu-btn"
            data-testid="menu-toggle-btn"
            aria-label="Open menu"
            aria-expanded="${state.drawerOpen ? 'true' : 'false'}"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M3 5.5H17M3 10H17M3 14.5H17" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            </svg>
          </button>
          ${renderHeaderTitle(hasCalendar)}
        </div>
        <div class="header-right">
          ${state.pendingCount > 0 ? `<span class="pending-badge" data-testid="pending-badge">${state.pendingCount} pending</span>` : ''}
          ${renderHeaderStatus(hasCalendar)}
        </div>
      </header>
      ${
        !state.isOnline
          ? '<div class="offline-banner" role="status" data-testid="offline-banner">You are offline. Changes are saved locally and will sync when you reconnect.</div>'
          : ''
      }
      <main class="main-content">
        ${mainContent}
      </main>
      ${state.drawerOpen ? renderNavDrawer(hasCalendar) : ''}
      ${state.addingTask && hasCalendar ? renderAddTaskModal({ categoryOrder: state.categoryOrder }) : ''}
      ${
        editingTask
          ? renderTaskEditor({
              task: editingTask,
              categoryOrder: state.categoryOrder,
              confirmingDelete: state.confirmingDelete,
            })
          : ''
      }
    </div>
  `;

  bindEvents();
  if (state.addingTask) {
    appRoot!.querySelector<HTMLInputElement>('#quick-add-summary')?.focus();
  } else if (state.focusedUid) {
    const inlineInput = appRoot!.querySelector<HTMLInputElement>(
      `input[data-inline-uid="${CSS.escape(state.focusedUid)}"]`,
    );
    if (inlineInput && document.activeElement !== inlineInput) {
      inlineInput.focus();
      const len = inlineInput.value.length;
      inlineInput.setSelectionRange(len, len);
    }
  }
}

function bindEvents(): void {
  // Header: open/close side drawer
  const openDrawer = () => {
    state.drawerOpen = true;
    render();
  };
  const closeDrawer = () => {
    state.drawerOpen = false;
    render();
  };

  appRoot!
    .querySelector<HTMLButtonElement>('#menu-toggle-btn')
    ?.addEventListener('click', () => {
      state.drawerOpen = !state.drawerOpen;
      render();
    });
  appRoot!
    .querySelector<HTMLButtonElement>('#header-title-btn')
    ?.addEventListener('click', openDrawer);
  appRoot!
    .querySelector<HTMLButtonElement>('#drawer-close-btn')
    ?.addEventListener('click', closeDrawer);
  appRoot!
    .querySelector<HTMLDivElement>('#drawer-backdrop')
    ?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) {
        closeDrawer();
      }
    });

  appRoot!
    .querySelectorAll<HTMLButtonElement>('[data-switch-calendar]')
    .forEach((btn) => {
      btn.addEventListener('click', () => {
        const href = btn.dataset.switchCalendar;
        if (!href) return;
        if (href === state.credentials?.calendarHref) {
          state.drawerOpen = false;
          state.tab = 'list';
          render();
          if (state.autoCategorize) {
            void maybeAutoCategorize(false);
          }
          return;
        }
        void switchCalendar(href, { openListTab: true });
      });
    });

  // Navigation items inside drawer
  appRoot!.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.tab as ActiveTab;
      if (!next) return;
      state.drawerOpen = false;
      state.tab = next;
      state.renamingCategoryIndex = null;
      render();
      if (next === 'list' && state.autoCategorize) {
        void maybeAutoCategorize(false);
      }
    });
  });

  // Floating + button & New Task modal
  appRoot!
    .querySelector<HTMLButtonElement>('#add-task-fab')
    ?.addEventListener('click', () => {
      state.addingTask = true;
      render();
    });

  const closeAddTaskModal = () => {
    state.addingTask = false;
    render();
  };
  appRoot!
    .querySelector<HTMLButtonElement>('#add-task-cancel')
    ?.addEventListener('click', closeAddTaskModal);
  appRoot!
    .querySelector<HTMLButtonElement>('#add-task-close-x')
    ?.addEventListener('click', closeAddTaskModal);
  appRoot!
    .querySelector<HTMLDivElement>('#add-task-backdrop')
    ?.addEventListener('click', (event) => {
      if (event.target === event.currentTarget) {
        closeAddTaskModal();
      }
    });

  // Manual sync button
  appRoot!.querySelector<HTMLButtonElement>('#sync-now-btn')?.addEventListener('click', () => {
    void runSync({ force: true });
  });

  // Settings: auth form
  const authForm = appRoot!.querySelector<HTMLFormElement>('#auth-form');
  authForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(authForm);
    const configPath = String(formData.get('configPath') ?? '').trim();
    const credentials: Credentials = {
      baseUrl: String(formData.get('baseUrl') ?? '').trim(),
      username: String(formData.get('username') ?? '').trim(),
      appPassword: String(formData.get('appPassword') ?? ''),
      ...(configPath ? { configPath } : {}),
    };
    state.credentials = credentials;
    await saveCredentials(credentials);
    syncEngine = createEngine(credentials);
    await discoverCalendars(credentials);
  });

  // Settings: logout
  appRoot!.querySelector<HTMLButtonElement>('#logout')?.addEventListener('click', async () => {
    autoCategorizeAbort?.abort();
    autoCategorizeAbort = null;
    attemptedAutoCategorizeUids.clear();
    await clearCredentials();
    syncEngine = null;
    state.credentials = undefined;
    state.calendars = [];
    state.tasks = [];
    state.conflicts = [];
    state.pendingCount = 0;
    state.editingUid = null;
    state.focusedUid = null;
    state.autoCategorize = false;
    state.autoCategorizeProgress = null;
    state.missingConfigPath = null;
    state.creatingConfig = false;
    state.drawerOpen = false;
    state.addingTask = false;
    state.connectionState = 'idle';
    state.statusMessage = 'Credentials and local cache cleared.';
    state.tab = 'settings';
    state.categoryOrder = await loadCategoryOrder();
    render();
  });

  // Settings: create missing config JSON file on Nextcloud
  appRoot!
    .querySelector<HTMLButtonElement>('#create-config-btn')
    ?.addEventListener('click', async () => {
      if (!state.credentials?.configPath || state.creatingConfig) return;
      const targetPath = state.credentials.configPath.trim();
      state.creatingConfig = true;
      state.statusMessage = `Creating ${targetPath}…`;
      render();

      try {
        const calHref = state.credentials.calendarHref;
        await createRemoteConfig(state.credentials, {
          categories: state.categoryOrder.slice(),
          ...(calHref
            ? {
                defaultCalendarHref: calHref,
                categoriesByCalendar: { [calHref]: state.categoryOrder.slice() },
              }
            : {}),
        });
        state.creatingConfig = false;
        state.missingConfigPath = null;
        state.statusMessage = `Created ${targetPath} on Nextcloud.`;
        render();
      } catch (error) {
        state.creatingConfig = false;
        state.statusMessage =
          error instanceof Error
            ? `Failed to create ${targetPath}: ${error.message}`
            : `Failed to create ${targetPath}.`;
        render();
      }
    });

  appRoot!
    .querySelector<HTMLButtonElement>('#dismiss-missing-config')
    ?.addEventListener('click', () => {
      state.missingConfigPath = null;
      render();
    });

  // Settings: calendar picker
  const calForm = appRoot!.querySelector<HTMLFormElement>('#calendar-form');
  calForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.credentials) return;
    const formData = new FormData(calForm);
    const calendarHref = String(formData.get('calendarHref') ?? '');
    if (!calendarHref) return;
    await switchCalendar(calendarHref, { forceSync: true, openListTab: true });
  });

  // Settings: auto-categorize toggle
  appRoot!
    .querySelector<HTMLInputElement>('#toggle-auto-categorize')
    ?.addEventListener('change', async (event) => {
      const enabled = (event.currentTarget as HTMLInputElement).checked;
      state.autoCategorize = enabled;
      await saveAutoCategorize(enabled);
      if (enabled) {
        attemptedAutoCategorizeUids.clear();
      } else {
        autoCategorizeAbort?.abort();
      }
      render();
    });

  // List: manual auto-categorize & stop buttons
  appRoot!
    .querySelector<HTMLButtonElement>('#run-auto-categorize')
    ?.addEventListener('click', () => {
      void maybeAutoCategorize(true);
    });
  appRoot!
    .querySelector<HTMLButtonElement>('#stop-auto-categorize')
    ?.addEventListener('click', () => {
      autoCategorizeAbort?.abort();
    });

  // List: clear all completed tasks
  appRoot!
    .querySelector<HTMLButtonElement>('#clear-completed-btn')
    ?.addEventListener('click', async () => {
      if (!syncEngine) return;
      const completed = state.tasks.filter((t) => t.status === 'COMPLETED');
      if (completed.length === 0) return;
      if (state.focusedUid && completed.some((t) => t.uid === state.focusedUid)) {
        state.focusedUid = null;
      }
      for (const task of completed) {
        await syncEngine.deleteTask(task.uid);
      }
      await flushOrScheduleSync();
    });

  // List: hide completed toggle
  appRoot!
    .querySelector<HTMLInputElement>('#toggle-hide-completed')
    ?.addEventListener('change', (event) => {
      state.hideCompleted = (event.currentTarget as HTMLInputElement).checked;
      render();
    });

  // List: add-task modal form
  const quickAddForm = appRoot!.querySelector<HTMLFormElement>('#quick-add-form');
  quickAddForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!syncEngine || !state.credentials?.calendarHref) return;
    const formData = new FormData(quickAddForm);
    const summary = String(formData.get('summary') ?? '').trim();
    const category = String(formData.get('category') ?? '').trim();
    const description = String(formData.get('description') ?? '').trim();
    if (!summary) return;
    state.addingTask = false;
    const created = await syncEngine.createTask(state.credentials.calendarHref, {
      summary,
      categories: category ? [category] : [],
      ...(description ? { description } : {}),
    });
    await flushOrScheduleSync();
    if (!category && state.autoCategorize) {
      attemptedAutoCategorizeUids.delete(created.uid);
      void maybeAutoCategorize(false);
    }
  });

  // List: toggle completion checkboxes (only checkbox toggles completion)
  appRoot!.querySelectorAll<HTMLInputElement>('[data-toggle-uid]').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const uid = checkbox.dataset.toggleUid;
      if (!uid || !syncEngine) return;
      await syncEngine.toggleTask(uid, checkbox.checked);
      await flushOrScheduleSync();
    });
  });

  // List: tap task body to focus inline edit & reveal Edit / Delete actions
  appRoot!.querySelectorAll<HTMLButtonElement>('[data-focus-uid]').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const uid = btn.dataset.focusUid ?? null;
      if (!uid) return;
      if (state.focusedUid && state.focusedUid !== uid) {
        await commitInlineEdit(state.focusedUid);
      }
      state.focusedUid = uid;
      render();
    });
  });

  // List: inline title editing (Enter saves & blurs)
  appRoot!.querySelectorAll<HTMLInputElement>('[data-inline-uid]').forEach((input) => {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void commitInlineEditAndBlur();
      }
    });
  });

  // List: open full editor from focused row
  appRoot!.querySelectorAll<HTMLButtonElement>('[data-edit-uid]').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const uid = btn.dataset.editUid ?? null;
      if (!uid) return;
      await commitInlineEdit(uid);
      state.focusedUid = null;
      state.editingUid = uid;
      state.confirmingDelete = false;
      render();
    });
  });

  // List: one-tap delete from focused row
  appRoot!.querySelectorAll<HTMLButtonElement>('[data-delete-uid]').forEach((btn) => {
    btn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const uid = btn.dataset.deleteUid;
      if (!uid || !syncEngine) return;
      state.focusedUid = null;
      await syncEngine.deleteTask(uid);
      await flushOrScheduleSync();
    });
  });

  // List: conflict resolution buttons
  appRoot!.querySelectorAll<HTMLButtonElement>('[data-resolve-conflict]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const choice = btn.dataset.resolveConflict as 'local' | 'server';
      const uid = btn.dataset.uid;
      if (!syncEngine || !uid) return;
      const conflict = state.conflicts.find((c) => c.uid === uid);
      if (!conflict) return;
      await syncEngine.resolveManualConflict(conflict, choice);
      state.conflicts = state.conflicts.filter((c) => c.uid !== uid);
      await refreshLocalState();
      state.statusMessage = `Resolved conflict for "${conflict.local.summary}".`;
      render();
    });
  });

  // Task editor modal
  const editorForm = appRoot!.querySelector<HTMLFormElement>('#task-editor-form');
  editorForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const uid = editorForm.dataset.uid;
    if (!uid || !syncEngine) return;
    const existing = state.tasks.find((t) => t.uid === uid);
    if (!existing) return;

    const formData = new FormData(editorForm);
    const summary = String(formData.get('summary') ?? '').trim();
    if (!summary) return;
    const categories = String(formData.get('categories') ?? '')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);
    const description = String(formData.get('description') ?? '').trim();
    const priority = parseInt(String(formData.get('priority') ?? '0'), 10);

    await syncEngine.updateTask({
      ...existing,
      summary,
      categories,
      description: description || undefined,
      priority: isNaN(priority) ? 0 : priority,
    });
    state.editingUid = null;
    state.confirmingDelete = false;
    await flushOrScheduleSync();
  });

  const closeEditor = () => {
    state.editingUid = null;
    state.confirmingDelete = false;
    render();
  };
  appRoot!.querySelector('#editor-cancel')?.addEventListener('click', closeEditor);
  appRoot!.querySelector('#editor-cancel-x')?.addEventListener('click', closeEditor);

  appRoot!.querySelector('#editor-delete')?.addEventListener('click', () => {
    state.confirmingDelete = true;
    render();
  });
  appRoot!.querySelector('#editor-delete-abort')?.addEventListener('click', () => {
    state.confirmingDelete = false;
    render();
  });
  appRoot!.querySelector('#editor-delete-confirm')?.addEventListener('click', async () => {
    if (!state.editingUid || !syncEngine) return;
    const uid = state.editingUid;
    state.editingUid = null;
    state.confirmingDelete = false;
    await syncEngine.deleteTask(uid);
    await flushOrScheduleSync();
  });

  // Category manager
  const addCategoryForm = appRoot!.querySelector<HTMLFormElement>('#add-category-form');
  addCategoryForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(addCategoryForm);
    const name = String(formData.get('categoryName') ?? '').trim();
    if (!name) return;
    if (!state.categoryOrder.some((c) => c.toLowerCase() === name.toLowerCase())) {
      await persistCategories([...state.categoryOrder, name]);
    }
  });

  appRoot!.querySelectorAll<HTMLButtonElement>('[data-move-up]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.moveUp);
      if (idx <= 0 || idx >= state.categoryOrder.length) return;
      const next = state.categoryOrder.slice();
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      await persistCategories(next);
    });
  });

  appRoot!.querySelectorAll<HTMLButtonElement>('[data-move-down]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.moveDown);
      if (idx < 0 || idx >= state.categoryOrder.length - 1) return;
      const next = state.categoryOrder.slice();
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      await persistCategories(next);
    });
  });

  appRoot!.querySelectorAll<HTMLButtonElement>('[data-start-rename]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.renamingCategoryIndex = Number(btn.dataset.startRename);
      render();
    });
  });

  appRoot!.querySelectorAll<HTMLButtonElement>('[data-rename-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.renamingCategoryIndex = null;
      render();
    });
  });

  appRoot!.querySelectorAll<HTMLFormElement>('.rename-category-form').forEach((form) => {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const idx = Number(form.dataset.renameIndex);
      const newName = String(new FormData(form).get('newName') ?? '').trim();
      if (!newName || idx < 0 || idx >= state.categoryOrder.length) return;
      const next = state.categoryOrder.slice();
      next[idx] = newName;
      state.renamingCategoryIndex = null;
      await persistCategories(next);
    });
  });

  appRoot!.querySelectorAll<HTMLButtonElement>('[data-delete-category]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.deleteCategory);
      const next = state.categoryOrder.filter((_, i) => i !== idx);
      await persistCategories(next);
    });
  });
}

void bootstrap();
