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
  pullToSync(): void;
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

interface VirtualTileInfo {
  type: string;
  index?: number;
  category?: string;
  taskIndex?: number;
  listIndex?: number;
}

interface VirtualTileDelegate {
  getTileInfo(index: number): VirtualTileInfo;
  configureTile(tile: unknown, info: VirtualTileInfo): void;
}

function createBrowserVirtualTileList(containerDom: HTMLElement, listKind: 'tasks' | 'lists') {
  let delegate: VirtualTileDelegate | null = null;
  let length = 0;
  let value = 0;
  let rowElements: HTMLElement[] = [];

  function applyScrollValue(nextVal: number) {
    value = Math.max(0, nextVal);
    const targetRow = rowElements[value];
    containerDom.scrollTop = targetRow ? targetRow.offsetTop : 0;
  }

  function makeSyncTile(info: VirtualTileInfo) {
    const row = document.createElement('div');
    row.className = 'watch-sync-tile';
    row.dataset.testid = listKind === 'tasks' ? 'watch-sync-tile' : 'watch-lists-sync-tile';

    const pill = document.createElement('div');
    pill.className = 'watch-sync-pill';
    pill.textContent = listKind === 'tasks' ? 'Sync Now' : 'Sync Lists';
    row.appendChild(pill);

    let clickHandler: (() => void) | null = null;
    row.addEventListener('click', () => {
      if (clickHandler) clickHandler();
    });

    const labelEl = {
      get text() {
        return pill.textContent ?? '';
      },
      set text(val: string) {
        pill.textContent = val;
      },
    };
    const touchEl = {
      get onclick() {
        return clickHandler;
      },
      set onclick(fn: (() => void) | null) {
        clickHandler = fn;
      },
    };

    const tile = {
      getElementById(id: string) {
        if (id === 'sync-label') return labelEl;
        if (id === 'sync-touch') return touchEl;
        return null;
      },
    };
    delegate?.configureTile(tile, info);
    return row;
  }

  function makeSpacerTile() {
    const row = document.createElement('div');
    row.className = 'watch-spacer-tile';
    row.dataset.testid = listKind === 'tasks' ? 'watch-tasks-spacer' : 'watch-lists-spacer';
    return row;
  }

  function makeCategoryHeaderTile(info: VirtualTileInfo, catIdx: number) {
    const row = document.createElement('div');
    row.className = 'watch-category-header';
    row.dataset.testid = `watch-category-${catIdx}`;

    const titleEl = {
      get text() {
        return row.textContent ?? '';
      },
      set text(val: string) {
        row.textContent = val;
        row.dataset.category = val;
      },
    };
    const tile = {
      getElementById(id: string) {
        if (id === 'category-title') return titleEl;
        return null;
      },
    };
    delegate?.configureTile(tile, info);
    return row;
  }

  function makeTaskTile(info: VirtualTileInfo) {
    const row = document.createElement('div');
    row.className = 'watch-task-tile';
    row.dataset.testid = `watch-item-${info.taskIndex ?? 0}`;
    row.dataset.checked = '0';

    const summaryEl = document.createElement('div');
    summaryEl.className = 'watch-task-summary';

    const boxEl = document.createElement('div');
    boxEl.className = 'watch-checkbox-box';

    row.append(summaryEl, boxEl);

    let clickHandler: (() => void) | null = null;
    row.addEventListener('click', () => {
      if (clickHandler) clickHandler();
    });

    const titleEl = {
      style: {
        get fill() {
          return summaryEl.style.color;
        },
        set fill(val: string) {
          summaryEl.style.color = val;
        },
      },
      get text() {
        return summaryEl.textContent ?? '';
      },
      set text(val: string) {
        summaryEl.textContent = val;
      },
    };

    const checkboxCheck = {
      style: {
        get display() {
          return row.dataset.checked === '1' ? 'inline' : 'none';
        },
        set display(val: string) {
          const checked = val !== 'none';
          row.dataset.checked = checked ? '1' : '0';
          boxEl.innerHTML = checked
            ? '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5L6.5 12L13 4.5" stroke="#ffffff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
            : '';
        },
      },
    };

    const touchEl = {
      get onclick() {
        return clickHandler;
      },
      set onclick(fn: (() => void) | null) {
        clickHandler = fn;
      },
    };

    const tile = {
      getElementById(id: string) {
        if (id === 'task-title') return titleEl;
        if (id === 'checkbox-check') return checkboxCheck;
        if (id === 'task-touch') return touchEl;
        return null;
      },
    };
    delegate?.configureTile(tile, info);
    return row;
  }

  function makeListTile(info: VirtualTileInfo) {
    const row = document.createElement('div');
    row.className = 'watch-list-tile';
    row.dataset.testid = `watch-list-item-${info.listIndex ?? 0}`;

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

    let clickHandler: (() => void) | null = null;
    row.addEventListener('click', () => {
      if (clickHandler) clickHandler();
    });

    const titleEl = {
      get text() {
        return titleDom.textContent ?? '';
      },
      set text(val: string) {
        titleDom.textContent = val;
      },
    };
    const subEl = {
      get text() {
        return subDom.textContent ?? '';
      },
      set text(val: string) {
        subDom.textContent = val;
      },
    };
    const touchEl = {
      get onclick() {
        return clickHandler;
      },
      set onclick(fn: (() => void) | null) {
        clickHandler = fn;
      },
    };

    const tile = {
      getElementById(id: string) {
        if (id === 'list-title') return titleEl;
        if (id === 'list-subtitle') return subEl;
        if (id === 'list-touch') return touchEl;
        return null;
      },
    };
    delegate?.configureTile(tile, info);
    return row;
  }

  function rebuild() {
    const prevScrollTop = containerDom.scrollTop;
    containerDom.innerHTML = '';
    rowElements = [];
    if (!delegate) return;

    let categoryCount = 0;
    for (let i = 0; i < length; i++) {
      const info = delegate.getTileInfo(i);
      let el: HTMLElement;
      if (info.type === 'sync-pool' || info.type === 'lists-sync-pool') {
        el = makeSyncTile(info);
      } else if (info.type === 'spacer-pool' || info.type === 'lists-spacer-pool') {
        el = makeSpacerTile();
      } else if (info.type === 'category-pool') {
        el = makeCategoryHeaderTile(info, categoryCount++);
      } else if (info.type === 'item-pool') {
        el = makeTaskTile(info);
      } else if (info.type === 'list-pool') {
        el = makeListTile(info);
      } else {
        el = makeSpacerTile();
      }
      rowElements.push(el);
      containerDom.appendChild(el);
    }
    containerDom.scrollTop = prevScrollTop;
  }

  return {
    get delegate() {
      return delegate;
    },
    set delegate(d: VirtualTileDelegate | null) {
      delegate = d;
    },
    get length() {
      return length;
    },
    set length(nextLen: number) {
      length = nextLen;
      rebuild();
    },
    get value() {
      return value;
    },
    set value(nextVal: number) {
      applyScrollValue(nextVal);
    },
  };
}

function createBrowserFitbitDocument(root: HTMLElement) {
  // Verify index.gui contains the expected panorama + virtual tile-list structure
  if (!indexGuiXml.includes('href="#panoramaview"') || !indexGuiXml.includes('<var id="virtual" value="1" />')) {
    throw new Error('fitbit/resources/index.gui missing expected #panoramaview or virtual #tile-list markup');
  }

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
    get text() {
      return statusDom.textContent ?? '';
    },
    set text(val: string) {
      statusDom.textContent = val;
    },
  };

  const pageHintEl = {
    get text() {
      return pageHintDom.textContent ?? '';
    },
    set text(val: string) {
      pageHintDom.textContent = val;
    },
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
    get value() {
      return panoramaValue;
    },
    set value(nextVal: number) {
      panoramaValue = nextVal === 1 ? 1 : 0;
      applyPanoramaDisplay();
    },
    get onvaluechange() {
      return onvaluechangeHandler;
    },
    set onvaluechange(fn: (() => void) | null) {
      onvaluechangeHandler = fn;
    },
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

  const checklistEl = createBrowserVirtualTileList(tasksViewDom, 'tasks');
  const listsChecklistEl = createBrowserVirtualTileList(listsViewDom, 'lists');

  return {
    doc: {
      getElementById(id: string) {
        if (id === 'status') return statusEl;
        if (id === 'page-hint') return pageHintEl;
        if (id === 'container') return containerEl;
        if (id === 'checklist') return checklistEl;
        if (id === 'lists-checklist') return listsChecklistEl;
        return null;
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
  pullToSync() {
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
