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
  bootstrapRemoteConfig,
  clearCredentials,
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
import { renderCategoryManager } from './ui/category-manager';
import { renderListView } from './ui/list-view';
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
  editingUid: string | null;
  confirmingDelete: boolean;
  renamingCategoryIndex: number | null;
  autoCategorize: boolean;
  promptApiAvailability: PromptApiAvailability;
  autoCategorizeProgress: string | null;
}

const appRoot = document.querySelector<HTMLDivElement>('#app');
if (!appRoot) throw new Error('App root not found');

const storage = new IndexedDbSyncStorage();
let syncEngine: SyncEngine | null = null;
let syncInFlight = false;
let autoCategorizeAbort: AbortController | null = null;
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
  editingUid: null,
  confirmingDelete: false,
  renamingCategoryIndex: null,
  autoCategorize: false,
  promptApiAvailability: 'unsupported',
  autoCategorizeProgress: null,
};

function createEngine(credentials: Credentials): SyncEngine {
  const client = createCalDavClient(credentials);
  return new SyncEngine(client, storage);
}

async function refreshLocalState(): Promise<void> {
  state.categoryOrder = await loadCategoryOrder();
  state.autoCategorize = await loadAutoCategorize();
  state.calendars = await storage.calendars.getAllCalendars();
  state.pendingCount = (await storage.queue.list()).length;
  if (state.credentials?.calendarHref) {
    state.tasks = await storage.tasks.getTasksByCalendar(state.credentials.calendarHref);
  } else {
    state.tasks = [];
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

  registerServiceWorker(() => {
    if (state.credentials?.calendarHref) {
      void runSync({ force: false });
    }
  });
}

async function discoverCalendars(credentials: Credentials): Promise<void> {
  state.connectionState = 'connecting';
  state.statusMessage = 'Connecting…';
  render();

  try {
    const remoteConfig = await bootstrapRemoteConfig(credentials);
    const client = createCalDavClient(credentials);
    const calendars = await client.listTaskCalendars();

    for (const cal of calendars) {
      await storage.calendars.putCalendar(cal);
    }

    state.calendars = calendars;
    state.categoryOrder = await loadCategoryOrder();

    if (calendars.length === 0) {
      state.connectionState = 'connected';
      state.statusMessage = 'Connected, but no VTODO task lists were found.';
      render();
      return;
    }

    const preferredHref = credentials.calendarHref || remoteConfig?.defaultCalendarHref;
    const matched = preferredHref && calendars.some((c) => c.href === preferredHref);

    if (matched && preferredHref) {
      const updatedCreds = { ...credentials, calendarHref: preferredHref };
      state.credentials = updatedCreds;
      await saveCredentials(updatedCreds);
      syncEngine = createEngine(updatedCreds);
      state.tab = 'list';
      await runSync({ force: true });
    } else {
      state.connectionState = 'connected';
      state.statusMessage = `Connected as ${credentials.username}. Select a task list to load.`;
      render();
    }
  } catch (error) {
    state.connectionState = 'error';
    state.statusMessage = error instanceof Error ? error.message : 'Connection failed';
    render();
  }
}

async function runSync(options: { force?: boolean } = {}): Promise<void> {
  if (!state.credentials?.calendarHref || !syncEngine || syncInFlight) return;

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
  state.categoryOrder = categories;
  attemptedAutoCategorizeUids.clear();
  render();
  await saveCategoryOrder(categories);

  if (state.credentials?.configPath && navigator.onLine) {
    try {
      const existing = (await loadTaskerConfig()) ?? {};
      const nextConfig = { ...existing, categories };
      delete nextConfig.aisles;
      await saveTaskerConfig(nextConfig);
      const webdav = createWebDavClient(state.credentials);
      await webdav.putJsonFile(state.credentials.configPath, nextConfig);
    } catch {
      // Local category update still succeeds if remote config write fails
    }
  }
}

function getActiveCalendarName(): string | undefined {
  if (!state.credentials?.calendarHref) return undefined;
  return state.calendars.find((c) => c.href === state.credentials?.calendarHref)?.displayName;
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
          statusMessage: state.statusMessage,
          hideCompleted: state.hideCompleted,
          calendarName: getActiveCalendarName(),
          promptApiAvailability: state.promptApiAvailability,
          autoCategorizeProgress: state.autoCategorizeProgress,
        })
      : state.tab === 'categories'
        ? renderCategoryManager({
            categories: state.categoryOrder,
            renamingIndex: state.renamingCategoryIndex,
          })
        : renderSettingsView({
            credentials: state.credentials,
            calendars: state.calendars,
            connectionStatus: state.statusMessage,
            connectionState: state.connectionState,
            autoCategorize: state.autoCategorize,
            promptApiAvailability: state.promptApiAvailability,
          });

  appRoot!.innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        <div class="brand">
          <h1>tasker</h1>
          ${state.pendingCount > 0 ? `<span class="pending-badge" data-testid="pending-badge">${state.pendingCount} pending</span>` : ''}
        </div>
        <nav class="nav-tabs" aria-label="Main navigation">
          <button type="button" class="nav-tab ${state.tab === 'list' ? 'active' : ''}" data-tab="list" ${!hasCalendar ? 'disabled' : ''}>Task List</button>
          <button type="button" class="nav-tab ${state.tab === 'categories' ? 'active' : ''}" data-tab="categories">Categories</button>
          <button type="button" class="nav-tab ${state.tab === 'settings' ? 'active' : ''}" data-tab="settings">Settings</button>
          ${hasCalendar ? `<button type="button" id="sync-now-btn" class="btn-sync" data-testid="sync-now" ${!state.isOnline ? 'disabled' : ''}>Sync</button>` : ''}
        </nav>
      </header>
      ${
        !state.isOnline
          ? '<div class="offline-banner" role="status" data-testid="offline-banner">You are offline. Changes are saved locally and will sync when you reconnect.</div>'
          : ''
      }
      <main class="main-content">
        ${mainContent}
      </main>
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
}

function bindEvents(): void {
  // Navigation tabs
  appRoot!.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = btn.dataset.tab as ActiveTab;
      if (!next) return;
      state.tab = next;
      state.renamingCategoryIndex = null;
      render();
      if (next === 'list' && state.autoCategorize) {
        void maybeAutoCategorize(false);
      }
    });
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
    state.autoCategorize = false;
    state.autoCategorizeProgress = null;
    state.connectionState = 'idle';
    state.statusMessage = 'Credentials and local cache cleared.';
    state.tab = 'settings';
    state.categoryOrder = await loadCategoryOrder();
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
    const credentials: Credentials = { ...state.credentials, calendarHref };
    state.credentials = credentials;
    await saveCredentials(credentials);
    syncEngine = createEngine(credentials);
    attemptedAutoCategorizeUids.clear();
    state.tab = 'list';
    state.statusMessage = 'Loading tasks…';
    render();
    await runSync({ force: true });
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

  // List: hide completed toggle
  appRoot!
    .querySelector<HTMLInputElement>('#toggle-hide-completed')
    ?.addEventListener('change', (event) => {
      state.hideCompleted = (event.currentTarget as HTMLInputElement).checked;
      render();
    });

  // List: quick-add form
  const quickAddForm = appRoot!.querySelector<HTMLFormElement>('#quick-add-form');
  quickAddForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!syncEngine || !state.credentials?.calendarHref) return;
    const formData = new FormData(quickAddForm);
    const summary = String(formData.get('summary') ?? '').trim();
    const category = String(formData.get('category') ?? '').trim();
    if (!summary) return;
    const created = await syncEngine.createTask(state.credentials.calendarHref, {
      summary,
      categories: category ? [category] : [],
    });
    await flushOrScheduleSync();
    if (!category && state.autoCategorize) {
      attemptedAutoCategorizeUids.delete(created.uid);
      void maybeAutoCategorize(false);
    }
  });

  // List: toggle completion checkboxes
  appRoot!.querySelectorAll<HTMLInputElement>('[data-toggle-uid]').forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      const uid = checkbox.dataset.toggleUid;
      if (!uid || !syncEngine) return;
      await syncEngine.toggleTask(uid, checkbox.checked);
      await flushOrScheduleSync();
    });
  });

  // List: open editor
  appRoot!.querySelectorAll<HTMLButtonElement>('[data-edit-uid]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.editingUid = btn.dataset.editUid ?? null;
      state.confirmingDelete = false;
      render();
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
