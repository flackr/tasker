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
  configureSettings(entries: Record<string, string>): void;
  getWatchState(): unknown;
  getCachedFile(): unknown;
}

declare global {
  interface Window {
    __fitbitHarness: HarnessApi;
  }
}

const FS_PREFIX = 'fitbit-fs:';
const SETTINGS_PREFIX = 'fitbit-settings:';

// Parse the real Fitbit index.gui to determine the declared tile slot IDs (item-0..N)
function extractTileIds(guiXml: string): string[] {
  const ids: string[] = [];
  const regex = /<use\s+id="(item-\d+)"/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(guiXml)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

function createBrowserFitbitDocument(root: HTMLElement, tileIds: string[]) {
  root.innerHTML = `
    <div class="watch-header">
      <div id="status" data-testid="watch-status">Loading...</div>
      <button id="sync-btn" type="button" data-testid="watch-sync-btn">Sync</button>
    </div>
    <div id="checklist" data-testid="watch-checklist"></div>
  `;

  const statusDom = root.querySelector<HTMLDivElement>('#status')!;
  const syncDom = root.querySelector<HTMLButtonElement>('#sync-btn')!;
  const checklistDom = root.querySelector<HTMLDivElement>('#checklist')!;

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

  const tileMap = new Map<string, ReturnType<typeof makeTile>>();

  function makeTile(id: string) {
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
    checklistDom.appendChild(row);

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

  for (const id of tileIds) {
    tileMap.set(id, makeTile(id));
  }

  return {
    getElementById(id: string) {
      if (id === 'status') return statusEl;
      if (id === 'sync-btn') return syncBtnEl;
      return tileMap.get(id) ?? null;
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

// Apply initial settings and online state from URL search params if provided
const params = new URLSearchParams(window.location.search);
for (const key of ['app_server', 'app_username', 'app_password', 'app_calendar', 'app_config_path']) {
  const val = params.get(key);
  if (val !== null) {
    fitbitSettingsStorage.setItem(key, JSON.stringify({ name: val }));
  }
}

let isBluetoothOnline = params.get('offline') !== '1';

const watchScreen = document.querySelector<HTMLElement>('#watch-screen')!;
const tileIds = extractTileIds(indexGuiXml);
const fitbitDoc = createBrowserFitbitDocument(watchScreen, tileIds);

// Wire the real Watch App ↔ in-memory Bluetooth bridge ↔ real Companion Sync
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
  configureSettings(entries: Record<string, string>) {
    for (const [k, v] of Object.entries(entries)) {
      fitbitSettingsStorage.setItem(k, JSON.stringify({ name: v }));
    }
    if (isBluetoothOnline) {
      void companion.handleFetchTasks();
    }
  },
  getWatchState() {
    return watchApp.getState();
  },
  getCachedFile() {
    try {
      return fitbitFs.readFileSync('tasker-cache.json');
    } catch {
      return null;
    }
  },
};

watchApp.start();
