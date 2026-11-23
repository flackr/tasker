import '@fontsource/inter/latin-400.css';
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

function createBrowserFitbitDocument(
  root: HTMLElement,
  listTileIds: string[],
  taskTileIds: string[],
) {
  root.innerHTML = `
    <div class="watch-header">
      <button id="back-btn" type="button" data-testid="watch-back-btn" style="display:none">Lists</button>
      <div id="status" data-testid="watch-status">Loading...</div>
      <button id="sync-btn" type="button" data-testid="watch-sync-btn">Sync</button>
    </div>
    <div id="lists-view" class="watch-view" data-testid="watch-lists-view"></div>
    <div id="tasks-view" class="watch-view" data-testid="watch-tasks-view" style="display:none"></div>
  `;

  const backDom = root.querySelector<HTMLButtonElement>('#back-btn')!;
  const statusDom = root.querySelector<HTMLDivElement>('#status')!;
  const syncDom = root.querySelector<HTMLButtonElement>('#sync-btn')!;
  const listsViewDom = root.querySelector<HTMLDivElement>('#lists-view')!;
  const tasksViewDom = root.querySelector<HTMLDivElement>('#tasks-view')!;

  const statusEl = {
    get text() {
      return statusDom.textContent ?? '';
    },
    set text(val: string) {
      statusDom.textContent = val;
    },
  };

  const syncBtnEl = {
    set onclick(fn: (() => void) | null) {
      syncDom.onclick = fn;
    },
  };

  const backBtnEl = {
    style: {
      get display() {
        return backDom.style.display;
      },
      set display(val: string) {
        backDom.style.display = val === 'none' ? 'none' : 'inline-block';
      },
    },
    set onclick(fn: (() => void) | null) {
      backDom.onclick = fn;
    },
  };

  const backBtnLabelEl = {
    style: { display: 'none' },
  };

  const listsViewEl = {
    style: {
      get display() {
        return listsViewDom.style.display;
      },
      set display(val: string) {
        listsViewDom.style.display = val === 'none' ? 'none' : 'block';
      },
    },
  };

  const tasksViewEl = {
    style: {
      get display() {
        return tasksViewDom.style.display;
      },
      set display(val: string) {
        tasksViewDom.style.display = val === 'none' ? 'none' : 'block';
      },
    },
  };

  const listTileMap = new Map<string, ReturnType<typeof makeListTile>>();
  const taskTileMap = new Map<string, ReturnType<typeof makeTaskTile>>();

  function makeListTile(id: string) {
    const row = document.createElement('div');
    row.className = 'watch-tile';
    row.dataset.testid = `watch-${id}`;
    row.style.display = 'none';

    const textWrap = document.createElement('div');
    textWrap.className = 'watch-tile-text';

    const titleDom = document.createElement('div');
    titleDom.className = 'watch-summary';

    const subDom = document.createElement('div');
    subDom.className = 'watch-aisle';

    const chevron = document.createElement('div');
    chevron.className = 'watch-chevron';
    chevron.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5L10.5 8L6 12.5" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    textWrap.append(titleDom, subDom);
    row.append(textWrap, chevron);
    listsViewDom.appendChild(row);

    let clickHandler: (() => void) | null = null;
    row.addEventListener('click', () => {
      if (clickHandler) clickHandler();
    });

    const tileList = {
      style: {
        get display() {
          return row.style.display;
        },
        set display(val: string) {
          row.style.display = val === 'none' ? 'none' : 'flex';
        },
      },
    };

    const title = {
      get text() {
        return titleDom.textContent ?? '';
      },
      set text(val: string) {
        titleDom.textContent = val;
      },
    };

    const subtitle = {
      get text() {
        return subDom.textContent ?? '';
      },
      set text(val: string) {
        subDom.textContent = val;
      },
    };

    const touch = {
      get onclick() {
        return clickHandler;
      },
      set onclick(fn: (() => void) | null) {
        clickHandler = fn;
      },
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

  function makeTaskTile(id: string) {
    const row = document.createElement('div');
    row.className = 'watch-tile';
    row.dataset.testid = `watch-${id}`;
    row.dataset.checked = '0';
    row.style.display = 'none';

    const textWrap = document.createElement('div');
    textWrap.className = 'watch-tile-text';

    const summaryEl = document.createElement('div');
    summaryEl.className = 'watch-summary';

    const aisleEl = document.createElement('div');
    aisleEl.className = 'watch-aisle';

    const boxEl = document.createElement('div');
    boxEl.className = 'watch-checkbox-box';

    textWrap.append(summaryEl, aisleEl);
    row.append(textWrap, boxEl);
    tasksViewDom.appendChild(row);

    let clickHandler: (() => void) | null = null;
    row.addEventListener('click', () => {
      if (clickHandler) clickHandler();
    });

    const tileList = {
      style: {
        get display() {
          return row.style.display;
        },
        set display(val: string) {
          row.style.display = val === 'none' ? 'none' : 'flex';
        },
      },
    };

    const checkbox = {
      get text() {
        return summaryEl.textContent ?? '';
      },
      set text(val: string) {
        summaryEl.textContent = val;
      },
      get value() {
        return row.dataset.checked === '1' ? 1 : 0;
      },
      set value(v: number) {
        row.dataset.checked = v ? '1' : '0';
        boxEl.innerHTML = v
          ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5L6.5 12L13 4.5" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
          : '';
      },
      get onclick() {
        return clickHandler;
      },
      set onclick(fn: (() => void) | null) {
        clickHandler = fn;
      },
    };

    const aisle = {
      get text() {
        return aisleEl.textContent ?? '';
      },
      set text(val: string) {
        aisleEl.textContent = val;
      },
    };

    return {
      getElementById(subId: string) {
        if (subId === 'task-tile-list') return tileList;
        if (subId === 'task-checkbox') return checkbox;
        if (subId === 'item-aisle') return aisle;
        return null;
      },
    };
  }

  for (const id of listTileIds) listTileMap.set(id, makeListTile(id));
  for (const id of taskTileIds) taskTileMap.set(id, makeTaskTile(id));

  return {
    getElementById(id: string) {
      if (id === 'status') return statusEl;
      if (id === 'sync-btn') return syncBtnEl;
      if (id === 'back-btn') return backBtnEl;
      if (id === 'back-btn-label') return backBtnLabelEl;
      if (id === 'lists-view') return listsViewEl;
      if (id === 'tasks-view') return tasksViewEl;
      return listTileMap.get(id) ?? taskTileMap.get(id) ?? null;
    },
  };
}

const fitbitFs = {
  readFileSync(filename: string) {
    const raw = localStorage.getItem(FS_PREFIX + filename);
    if (raw === null) throw new Error(`ENOENT: ${filename}`);
    return JSON.parse(raw);
  },
  writeFileSync(filename: string, data: unknown) {
    localStorage.setItem(FS_PREFIX + filename, JSON.stringify(data));
  },
};

const fitbitSettingsStorage = {
  getItem(key: string) {
    return localStorage.getItem(SETTINGS_PREFIX + key);
  },
  setItem(key: string, value: string) {
    localStorage.setItem(SETTINGS_PREFIX + key, value);
  },
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
const listTileIds = extractIds(indexGuiXml, 'list-item-');
const taskTileIds = extractIds(indexGuiXml, 'item-');
const fitbitDoc = createBrowserFitbitDocument(watchScreen, listTileIds, taskTileIds);

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
  document: fitbitDoc,
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
      return fitbitFs.readFileSync(filename);
    } catch {
      return null;
    }
  },
};

watchApp.start();
