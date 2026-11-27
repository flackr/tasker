import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-500.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/inter/latin-700.css';
// @ts-expect-error raw Vite import of Fitbit GUI XML
import indexGuiXml from '../../resources/index.gui?raw';
// @ts-expect-error JS watch app controller
import { createWatchApp } from '../../app/watch-app.js';
// @ts-expect-error JS companion sync controller
import { createCompanionSync } from '../../companion/sync.js';

interface HarnessApi {
  setOnline(online: boolean): void;
  setFixedNow(epochMs: number | null): void;
  configureSettings(entries: Record<string, string>): void;
  pressHardwareBack(): boolean;
  swipeToLists(): void;
  swipeToTasks(): void;
  pullToActions(): void;
  getPanoramaValue(): number;
  getTasksScrollValue(): number;
  getWatchState(): unknown;
  listFsFiles(): string[];
  readFsFile(filename: string): unknown;
}

declare global {
  interface Window {
    __fitbitHarness: HarnessApi;
  }
}

const FS_PREFIX = 'fitbit-fs:';
const SETTINGS_PREFIX = 'fitbit-settings:';

function extractIds(guiXml: string, prefix: string): string[] {
  const ids: string[] = [];
  const regex = new RegExp(`<use\\s+id="(${prefix}\\d+)"`, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(guiXml)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

function createBrowserFitbitDocument(root: HTMLElement) {
  if (!indexGuiXml.includes('href="#panoramaview"') || indexGuiXml.includes('<var id="virtual" value="1" />')) {
    throw new Error('fitbit/resources/index.gui must use #panoramaview and static #tile-list (not virtual="1")');
  }

  const rowIds = extractIds(indexGuiXml, 'row-');
  const listTileIds = extractIds(indexGuiXml, 'list-item-');

  root.innerHTML = `
    <div class="watch-header">
      <div id="status" data-testid="watch-status">Loading...</div>
      <div id="page-hint" data-testid="watch-page-hint">Lists ›</div>
    </div>
    <div id="container" class="watch-panorama">
      <div id="tasks-view" class="watch-view" data-testid="watch-tasks-view"></div>
      <div id="lists-view" class="watch-view" data-testid="watch-lists-view" style="display:none"></div>
    </div>
  `;

  const statusDom = root.querySelector<HTMLDivElement>('#status')!;
  const pageHintDom = root.querySelector<HTMLDivElement>('#page-hint')!;
  const tasksViewDom = root.querySelector<HTMLDivElement>('#tasks-view')!;
  const listsViewDom = root.querySelector<HTMLDivElement>('#lists-view')!;

  const statusEl = {
    get text() { return statusDom.textContent ?? ''; },
    set text(val: string) { statusDom.textContent = val; },
  };
  const pageHintEl = {
    get text() { return pageHintDom.textContent ?? ''; },
    set text(val: string) { pageHintDom.textContent = val; },
  };

  let panoramaValue = 0;
  const listeners = new Map<string, Array<() => void>>();
  let onvaluechangeHandler: (() => void) | null = null;

  function applyPanoramaDisplay() {
    tasksViewDom.style.display = panoramaValue === 0 ? 'block' : 'none';
    listsViewDom.style.display = panoramaValue === 1 ? 'block' : 'none';
  }

  function notifyPanoramaChange() {
    if (onvaluechangeHandler) onvaluechangeHandler();
    for (const evt of ['change', 'select']) {
      for (const fn of listeners.get(evt) ?? []) fn();
    }
  }

  const containerEl = {
    get value() { return panoramaValue; },
    set value(nextVal: number) {
      panoramaValue = nextVal === 1 ? 1 : 0;
      applyPanoramaDisplay();
    },
    get onvaluechange() { return onvaluechangeHandler; },
    set onvaluechange(fn: (() => void) | null) { onvaluechangeHandler = fn; },
    addEventListener(evt: string, fn: () => void) {
      const list = listeners.get(evt) ?? [];
      list.push(fn);
      listeners.set(evt, list);
    },
    swipeTo(page: number) {
      panoramaValue = page === 1 ? 1 : 0;
      applyPanoramaDisplay();
      notifyPanoramaChange();
    },
  };

  // Tasks static tile-list children: row 0 (top spacer), row 1 (actions), rows 2..N (unified rows)
  const topSpacerDom = document.createElement('div');
  topSpacerDom.className = 'watch-top-spacer';
  topSpacerDom.dataset.testid = 'watch-top-spacer';
  tasksViewDom.appendChild(topSpacerDom);
  const topSpacerRow = {
    getElementById(id: string) {
      if (id === 'active-list-label') {
        return {
          get text() { return topSpacerDom.textContent ?? ''; },
          set text(val: string) { topSpacerDom.textContent = val; },
        };
      }
      return null;
    },
  };

  const actionsDom = document.createElement('div');
  actionsDom.className = 'watch-actions-tile';
  actionsDom.dataset.testid = 'watch-actions-tile';
  const syncBtn = document.createElement('button');
  syncBtn.type = 'button';
  syncBtn.className = 'watch-action-btn watch-sync-btn';
  syncBtn.dataset.testid = 'watch-sync-btn';
  syncBtn.textContent = 'Sync';
  const autoBtn = document.createElement('button');
  autoBtn.type = 'button';
  autoBtn.className = 'watch-action-btn watch-autohide-btn';
  autoBtn.dataset.testid = 'watch-autohide-btn';
  autoBtn.textContent = 'Autohide';
  actionsDom.append(syncBtn, autoBtn);
  tasksViewDom.appendChild(actionsDom);

  let syncClick: (() => void) | null = null;
  syncBtn.addEventListener('click', () => { if (syncClick) syncClick(); });
  let autoClick: (() => void) | null = null;
  autoBtn.addEventListener('click', () => { if (autoClick) autoClick(); });

  const actionsRow = {
    getElementById(id: string) {
      if (id === 'sync-label') {
        return {
          get text() { return syncBtn.textContent ?? ''; },
          set text(val: string) { syncBtn.textContent = val; },
        };
      }
      if (id === 'sync-touch') {
        return {
          get onclick() { return syncClick; },
          set onclick(fn: (() => void) | null) { syncClick = fn; },
        };
      }
      if (id === 'autohide-label') {
        return {
          get text() { return autoBtn.textContent ?? ''; },
          set text(val: string) { autoBtn.textContent = val; },
        };
      }
      if (id === 'autohide-touch') {
        return {
          style: {
            get fill() { return autoBtn.style.backgroundColor; },
            set fill(val: string) { autoBtn.style.backgroundColor = val; },
          },
          get onclick() { return autoClick; },
          set onclick(fn: (() => void) | null) { autoClick = fn; },
        };
      }
      return null;
    },
  };

  interface RowSlotEntry {
    wrapper: HTMLDivElement;
    catWrap: HTMLDivElement;
    taskWrap: HTMLDivElement;
    isVisible: () => boolean;
    getKind: () => 'category' | 'task' | null;
  }
  const rowSlotEntries: RowSlotEntry[] = [];
  const rowMap = new Map<string, ReturnType<typeof makeRowSlot>>();

  function refreshDynamicTestIds() {
    let catIdx = 0;
    let taskIdx = 0;
    for (const entry of rowSlotEntries) {
      if (!entry.isVisible()) {
        delete entry.catWrap.dataset.testid;
        delete entry.taskWrap.dataset.testid;
        continue;
      }
      const kind = entry.getKind();
      if (kind === 'category') {
        entry.catWrap.dataset.testid = `watch-category-${catIdx++}`;
        delete entry.taskWrap.dataset.testid;
      } else if (kind === 'task') {
        delete entry.catWrap.dataset.testid;
        entry.taskWrap.dataset.testid = `watch-item-${taskIdx++}`;
      }
    }
  }

  function makeRowSlot() {
    const wrapper = document.createElement('div');
    wrapper.style.display = 'none';

    const catWrap = document.createElement('div');
    catWrap.className = 'watch-category-header';
    catWrap.style.display = 'none';
    const band = document.createElement('div');
    band.className = 'watch-category-band';
    catWrap.appendChild(band);

    const taskWrap = document.createElement('div');
    taskWrap.className = 'watch-task-tile';
    taskWrap.dataset.checked = '0';
    taskWrap.style.display = 'none';
    const summaryEl = document.createElement('div');
    summaryEl.className = 'watch-task-summary';
    const boxEl = document.createElement('div');
    boxEl.className = 'watch-checkbox-box';
    taskWrap.append(summaryEl, boxEl);

    wrapper.append(catWrap, taskWrap);
    tasksViewDom.appendChild(wrapper);

    let clickHandler: (() => void) | null = null;
    taskWrap.addEventListener('click', () => {
      if (clickHandler) clickHandler();
    });

    let visible = false;
    let kind: 'category' | 'task' | null = null;

    rowSlotEntries.push({
      wrapper,
      catWrap,
      taskWrap,
      isVisible: () => visible,
      getKind: () => kind,
    });

    const tileList = {
      style: {
        get display() { return visible ? 'inline' : 'none'; },
        set display(val: string) {
          visible = val !== 'none';
          wrapper.style.display = visible ? 'block' : 'none';
          refreshDynamicTestIds();
        },
      },
    };
    const categoryGroup = {
      style: {
        get display() { return catWrap.style.display; },
        set display(val: string) {
          const show = val !== 'none';
          catWrap.style.display = show ? 'flex' : 'none';
          if (show) kind = 'category';
          refreshDynamicTestIds();
        },
      },
    };
    const categoryTitle = {
      get text() { return band.textContent ?? ''; },
      set text(val: string) {
        band.textContent = val;
        catWrap.dataset.category = val;
      },
    };
    const taskGroup = {
      style: {
        get display() { return taskWrap.style.display; },
        set display(val: string) {
          const show = val !== 'none';
          taskWrap.style.display = show ? 'flex' : 'none';
          if (show) kind = 'task';
          refreshDynamicTestIds();
        },
      },
    };
    const taskTitle = {
      style: {
        get fill() { return summaryEl.style.color; },
        set fill(val: string) { summaryEl.style.color = val; },
      },
      get text() { return summaryEl.textContent ?? ''; },
      set text(val: string) { summaryEl.textContent = val; },
    };
    const checkboxCheck = {
      style: {
        get display() { return taskWrap.dataset.checked === '1' ? 'inline' : 'none'; },
        set display(val: string) {
          const checked = val !== 'none';
          taskWrap.dataset.checked = checked ? '1' : '0';
          boxEl.innerHTML = checked
            ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5L6.5 12L13 4.5" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            : '';
        },
      },
    };
    const taskTouch = {
      get onclick() { return clickHandler; },
      set onclick(fn: (() => void) | null) { clickHandler = fn; },
    };

    return {
      getElementById(id: string) {
        if (id === 'row-tile-list') return tileList;
        if (id === 'category-group') return categoryGroup;
        if (id === 'category-title') return categoryTitle;
        if (id === 'task-group') return taskGroup;
        if (id === 'task-title') return taskTitle;
        if (id === 'checkbox-check') return checkboxCheck;
        if (id === 'task-touch') return taskTouch;
        return null;
      },
    };
  }

  for (const id of rowIds) {
    rowMap.set(id, makeRowSlot());
  }

  // Lists static tile-list children: row 0 (Sync Lists), rows 1..N (list-item-i)
  const listsSyncDom = document.createElement('div');
  listsSyncDom.className = 'watch-lists-sync-tile';
  listsSyncDom.dataset.testid = 'watch-lists-sync-tile';
  const listsSyncPill = document.createElement('div');
  listsSyncPill.className = 'watch-lists-sync-pill';
  listsSyncPill.textContent = 'Sync Lists';
  listsSyncDom.appendChild(listsSyncPill);
  listsViewDom.appendChild(listsSyncDom);

  let listsSyncClick: (() => void) | null = null;
  listsSyncDom.addEventListener('click', () => { if (listsSyncClick) listsSyncClick(); });
  const listsSyncRow = {
    getElementById(id: string) {
      if (id === 'lists-sync-label') {
        return {
          get text() { return listsSyncPill.textContent ?? ''; },
          set text(val: string) { listsSyncPill.textContent = val; },
        };
      }
      if (id === 'lists-sync-touch') {
        return {
          get onclick() { return listsSyncClick; },
          set onclick(fn: (() => void) | null) { listsSyncClick = fn; },
        };
      }
      return null;
    },
  };

  const listTileMap = new Map<string, ReturnType<typeof makeListTile>>();
  function makeListTile(id: string) {
    const row = document.createElement('div');
    row.className = 'watch-list-tile';
    row.dataset.testid = `watch-${id}`;
    row.style.display = 'none';

    const textWrap = document.createElement('div');
    textWrap.className = 'watch-list-text';
    const titleDom = document.createElement('div');
    titleDom.className = 'watch-list-title';
    const subDom = document.createElement('div');
    subDom.className = 'watch-list-subtitle';
    const chevron = document.createElement('div');
    chevron.className = 'watch-chevron';
    chevron.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5L10.5 8L6 12.5" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    textWrap.append(titleDom, subDom);
    row.append(textWrap, chevron);
    listsViewDom.appendChild(row);

    let clickHandler: (() => void) | null = null;
    row.addEventListener('click', () => { if (clickHandler) clickHandler(); });

    const tileList = {
      style: {
        get display() { return row.style.display; },
        set display(val: string) { row.style.display = val === 'none' ? 'none' : 'flex'; },
      },
    };
    const title = {
      get text() { return titleDom.textContent ?? ''; },
      set text(val: string) { titleDom.textContent = val; },
    };
    const subtitle = {
      get text() { return subDom.textContent ?? ''; },
      set text(val: string) { subDom.textContent = val; },
    };
    const touch = {
      get onclick() { return clickHandler; },
      set onclick(fn: (() => void) | null) { clickHandler = fn; },
    };

    return {
      getElementById(subId: string) {
        if (subId === 'list-tile-list') return tileList;
        if (subId === 'list-title') return title;
        if (subId === 'list-subtitle') return subtitle;
        if (subId === 'list-touch') return touch;
        return null;
      },
    };
  }

  for (const id of listTileIds) {
    listTileMap.set(id, makeListTile(id));
  }

  let tasksScrollValue = 0;
  const checklistEl = {
    get value() { return tasksScrollValue; },
    set value(nextVal: number) {
      tasksScrollValue = Math.max(0, nextVal);
      const visibleChildren = Array.from(tasksViewDom.children).filter(
        (el) => (el as HTMLElement).style.display !== 'none',
      ) as HTMLElement[];
      const target = visibleChildren[tasksScrollValue];
      tasksViewDom.scrollTop = target ? target.offsetTop : 0;
    },
  };

  let listsScrollValue = 0;
  const listsChecklistEl = {
    get value() { return listsScrollValue; },
    set value(nextVal: number) {
      listsScrollValue = Math.max(0, nextVal);
      const visibleChildren = Array.from(listsViewDom.children).filter(
        (el) => (el as HTMLElement).style.display !== 'none',
      ) as HTMLElement[];
      const target = visibleChildren[listsScrollValue];
      listsViewDom.scrollTop = target ? target.offsetTop : 0;
    },
  };

  return {
    doc: {
      getElementById(id: string) {
        if (id === 'status') return statusEl;
        if (id === 'page-hint') return pageHintEl;
        if (id === 'container') return containerEl;
        if (id === 'checklist') return checklistEl;
        if (id === 'lists-checklist') return listsChecklistEl;
        if (id === 'top-spacer-row') return topSpacerRow;
        if (id === 'actions-row') return actionsRow;
        if (id === 'lists-sync-row') return listsSyncRow;
        return rowMap.get(id) ?? listTileMap.get(id) ?? null;
      },
    },
    containerEl,
    checklistEl,
    listsChecklistEl,
  };
}

const VALID_FITBIT_FS_ENCODINGS = new Set(['cbor', 'json', 'utf-8', 'ascii']);

const fitbitFs = {
  readFileSync(filename: string, encoding?: string) {
    if (!encoding || !VALID_FITBIT_FS_ENCODINGS.has(encoding)) {
      throw new Error(`Invalid Fitbit fs encoding: ${String(encoding)}`);
    }
    const raw = localStorage.getItem(FS_PREFIX + filename);
    if (raw === null) throw new Error(`ENOENT: ${filename}`);
    const parsed = JSON.parse(raw) as { encoding?: string; data?: unknown };
    if (parsed && typeof parsed === 'object' && 'encoding' in parsed && 'data' in parsed) {
      if (parsed.encoding !== encoding) {
        throw new Error(`Encoding mismatch reading ${filename}: expected ${parsed.encoding}, got ${encoding}`);
      }
      return parsed.data;
    }
    return parsed;
  },
  writeFileSync(filename: string, data: unknown, encoding?: string) {
    if (!encoding || !VALID_FITBIT_FS_ENCODINGS.has(encoding)) {
      throw new Error(`Invalid Fitbit fs encoding: ${String(encoding)}`);
    }
    if (!filename || filename.startsWith('/') || filename.length > 24) {
      throw new Error(`Unsafe Fitbit fs filename: ${filename}`);
    }
    localStorage.setItem(FS_PREFIX + filename, JSON.stringify({ encoding, data }));
  },
};

const fitbitSettingsStorage = {
  getItem(key: string) { return localStorage.getItem(SETTINGS_PREFIX + key); },
  setItem(key: string, value: string) { localStorage.setItem(SETTINGS_PREFIX + key, value); },
};

const params = new URLSearchParams(window.location.search);
for (const key of ['app_server', 'app_username', 'app_password', 'app_calendar', 'app_config_path']) {
  const val = params.get(key);
  if (val !== null) {
    fitbitSettingsStorage.setItem(key, JSON.stringify({ name: val }));
  }
}

let isBluetoothOnline = params.get('offline') !== '1';
const fixedNowParam = params.get('now');
let fixedNowMs: number | null = fixedNowParam ? Number(fixedNowParam) : null;

const watchScreen = document.querySelector<HTMLElement>('#watch-screen')!;
const browserUi = createBrowserFitbitDocument(watchScreen);

let watchApp: ReturnType<typeof createWatchApp>;
const companion = createCompanionSync({
  settingsStorage: fitbitSettingsStorage,
  send: (msg: unknown) => {
    if (!isBluetoothOnline) return;
    queueMicrotask(() => {
      if (isBluetoothOnline) {
        watchApp.onMessage(msg);
      }
    });
  },
});

watchApp = createWatchApp({
  document: browserUi.doc,
  fs: fitbitFs,
  now: () => (fixedNowMs !== null ? fixedNowMs : Date.now()),
  isConnected: () => isBluetoothOnline,
  send: (msg: unknown) => {
    if (!isBluetoothOnline) return;
    void companion.onMessage(msg);
  },
});

window.__fitbitHarness = {
  setOnline(online: boolean) {
    isBluetoothOnline = online;
    watchApp.onConnectionChange(online);
  },
  setFixedNow(epochMs: number | null) {
    fixedNowMs = epochMs;
  },
  configureSettings(entries: Record<string, string>) {
    for (const [k, v] of Object.entries(entries)) {
      fitbitSettingsStorage.setItem(k, JSON.stringify({ name: v }));
    }
    if (isBluetoothOnline) {
      void companion.handleFetchLists();
    }
  },
  pressHardwareBack() {
    return watchApp.goBack();
  },
  swipeToLists() {
    browserUi.containerEl.swipeTo(1);
  },
  swipeToTasks() {
    browserUi.containerEl.swipeTo(0);
  },
  pullToActions() {
    if (browserUi.containerEl.value === 1) {
      browserUi.listsChecklistEl.value = 0;
    } else {
      browserUi.checklistEl.value = 0;
    }
  },
  getPanoramaValue() {
    return browserUi.containerEl.value;
  },
  getTasksScrollValue() {
    return browserUi.checklistEl.value;
  },
  getWatchState() {
    return watchApp.getState();
  },
  listFsFiles() {
    const names: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(FS_PREFIX)) {
        names.push(k.slice(FS_PREFIX.length));
      }
    }
    return names.sort();
  },
  readFsFile(filename: string) {
    try {
      return fitbitFs.readFileSync(filename, filename.endsWith('.json') ? 'json' : 'cbor');
    } catch {
      return null;
    }
  },
};

watchApp.start();
