import {
  acknowledgeWatchToggle,
  applyOptimisticToggle,
  createChunkReassembler,
  reconcileWatchTasks,
  sortTasksByCategory,
} from "@tasker/core/watch";

var LISTS_INDEX_FILE = "t-lists.cbor";
var LEGACY_INDEX_FILE = "tasker-lists.json";
var LEGACY_CACHE_FILE = "tasker-cache.json";

function computeCalendarHash(calendarHref) {
  var hash = 0x811c9dc5;
  var input = String(calendarHref || "default");
  for (var i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash =
      (hash +
        (hash << 1) +
        (hash << 4) +
        (hash << 7) +
        (hash << 8) +
        (hash << 24)) >>>
      0;
  }
  var hex = hash.toString(16);
  while (hex.length < 8) {
    hex = "0" + hex;
  }
  return hex;
}

/**
 * Computes a short deterministic CBOR filename (ES5-safe FNV-1a 32-bit hex) for a
 * calendar's per-list storage file on Fitbit OS File Storage (15 chars total).
 */
export function getListCacheFilename(calendarHref) {
  return "t-" + computeCalendarHash(calendarHref) + ".cbor";
}

function getLegacyListCacheFilename(calendarHref) {
  return "tasker-list-" + computeCalendarHash(calendarHref) + ".json";
}

function readDataFile(fs, filename, encoding) {
  if (!fs || typeof fs.readFileSync !== "function") {
    return null;
  }
  try {
    var data = fs.readFileSync(filename, encoding || "cbor");
    if (data && typeof data === "object") {
      return data;
    }
  } catch (e) {
    // Missing file on first launch
  }
  return null;
}

function writeDataFile(fs, filename, data) {
  if (!fs || typeof fs.writeFileSync !== "function") {
    return;
  }
  try {
    fs.writeFileSync(filename, data, "cbor");
  } catch (e) {
    // Ignore storage errors cleanly
  }
}

function sanitizeCompactTask(task) {
  var out = {
    uid: String(task.uid || ""),
    summary: String(task.summary || ""),
    categories: Array.isArray(task.categories) ? task.categories.slice() : [],
    completed: Boolean(task.completed),
  };
  if (typeof task.etag === "string") {
    out.etag = task.etag;
  }
  if (typeof task.lastModified === "number" && !isNaN(task.lastModified)) {
    out.lastModified = task.lastModified;
  }
  return out;
}

function sanitizeCalendars(calendars) {
  var out = [];
  if (!Array.isArray(calendars)) return out;
  for (var i = 0; i < calendars.length; i++) {
    var c = calendars[i];
    if (c && c.href) {
      out.push({
        href: String(c.href),
        displayName: String(c.displayName || c.href),
      });
    }
  }
  return out;
}

function readListsIndex(fs) {
  var data = readDataFile(fs, LISTS_INDEX_FILE, "cbor");
  if (!data) {
    data = readDataFile(fs, LEGACY_INDEX_FILE, "json");
  }
  if (data) {
    var order = Array.isArray(data.categoryOrder)
      ? data.categoryOrder
      : Array.isArray(data.aisleOrder)
        ? data.aisleOrder
        : [];
    return {
      calendars: Array.isArray(data.calendars) ? data.calendars : [],
      activeCalendarHref: data.activeCalendarHref,
      categoryOrder: order,
    };
  }
  // Backwards-compatible migration from single-file cache
  var legacy = readDataFile(fs, LEGACY_CACHE_FILE, "json");
  if (legacy && legacy.calendarHref) {
    writeListStore(
      fs,
      legacy.calendarHref,
      Array.isArray(legacy.tasks) ? legacy.tasks : [],
      Array.isArray(legacy.pending) ? legacy.pending : [],
      legacy.lastSyncedAt,
      undefined,
    );
    return {
      calendars: [{ href: legacy.calendarHref, displayName: "Tasks" }],
      activeCalendarHref: legacy.calendarHref,
      categoryOrder: Array.isArray(legacy.categoryOrder)
        ? legacy.categoryOrder
        : Array.isArray(legacy.aisleOrder)
          ? legacy.aisleOrder
          : [],
    };
  }
  return null;
}

function writeListsIndex(fs, state) {
  var record = {
    calendars: sanitizeCalendars(state.calendars),
    categoryOrder: Array.isArray(state.categoryOrder) ? state.categoryOrder.slice() : [],
  };
  if (state.activeCalendarHref) {
    record.activeCalendarHref = String(state.activeCalendarHref);
  }
  writeDataFile(fs, LISTS_INDEX_FILE, record);
}

function readListStore(fs, calendarHref) {
  if (!calendarHref) return null;
  var data = readDataFile(fs, getListCacheFilename(calendarHref), "cbor");
  if (!data) {
    data = readDataFile(fs, getLegacyListCacheFilename(calendarHref), "json");
  }
  if (!data) return null;
  return {
    calendarHref: data.calendarHref || calendarHref,
    tasks: Array.isArray(data.tasks) ? data.tasks : [],
    pending: Array.isArray(data.pending) ? data.pending : [],
    lastSyncedAt: data.lastSyncedAt,
    categoryOrder: Array.isArray(data.categoryOrder) ? data.categoryOrder : undefined,
  };
}

function writeListStore(fs, calendarHref, tasks, pending, lastSyncedAt, categoryOrder) {
  if (!calendarHref) return;
  var cleanTasks = [];
  if (Array.isArray(tasks)) {
    for (var i = 0; i < tasks.length; i++) {
      cleanTasks.push(sanitizeCompactTask(tasks[i]));
    }
  }
  var cleanPending = [];
  if (Array.isArray(pending)) {
    for (var j = 0; j < pending.length; j++) {
      var p = pending[j];
      if (p && p.uid) {
        cleanPending.push({
          uid: String(p.uid),
          completed: Boolean(p.completed),
          updatedAt: typeof p.updatedAt === "number" ? p.updatedAt : 0,
        });
      }
    }
  }
  var record = {
    calendarHref: String(calendarHref),
    tasks: cleanTasks,
    pending: cleanPending,
  };
  if (typeof lastSyncedAt === "number" && !isNaN(lastSyncedAt)) {
    record.lastSyncedAt = lastSyncedAt;
  }
  if (Array.isArray(categoryOrder)) {
    record.categoryOrder = categoryOrder.slice();
  }
  writeDataFile(fs, getListCacheFilename(calendarHref), record);
}

function getCategoryLabel(task) {
  if (task && task.categories && task.categories.length > 0) {
    return task.categories[0];
  }
  return "";
}

/**
 * Builds the flat virtual-tile row list for the Tasks VirtualTileList:
 * - Row 0: pull-down full-width Sync tile (scrolled past by default via value=1)
 * - Row 1: 28px spacer aligning row 2 cleanly beneath the 28px sticky status bar
 * - Rows 2+: short category header tiles interleaved before each category group,
 *   followed by large-font single-line task tiles.
 */
export function buildTaskRows(items) {
  var rows = [{ type: "sync-pool" }, { type: "spacer-pool" }];
  if (!Array.isArray(items) || items.length === 0) {
    return rows;
  }

  var hasAnyCategory = false;
  for (var i = 0; i < items.length; i++) {
    if (getCategoryLabel(items[i])) {
      hasAnyCategory = true;
      break;
    }
  }

  var lastCategory = null;
  for (var j = 0; j < items.length; j++) {
    var cat = getCategoryLabel(items[j]);
    if (hasAnyCategory) {
      var headerLabel = cat || "Uncategorized";
      if (headerLabel !== lastCategory) {
        rows.push({ type: "category-pool", category: headerLabel });
        lastCategory = headerLabel;
      }
    }
    rows.push({ type: "item-pool", taskIndex: j });
  }
  return rows;
}

function buildListRows(calendars) {
  var rows = [{ type: "lists-sync-pool" }, { type: "lists-spacer-pool" }];
  if (!Array.isArray(calendars)) {
    return rows;
  }
  for (var i = 0; i < calendars.length; i++) {
    rows.push({ type: "list-pool", listIndex: i });
  }
  return rows;
}

/**
 * Creates the Fitbit Versa 2 Watch App controller (ES5-safe).
 *
 * Features:
 * - Native `#panoramaview` horizontal navigation: Page 0 = active task list,
 *   Page 1 = Lists picker (swipe from the right to switch lists, hardware Back
 *   from Page 1 returns to Page 0, hardware Back from Page 0 exits cleanly)
 * - Slim 28px status-only header bar
 * - Virtual `#tile-list` with a pull-down full-width Sync tile at row 0 (started
 *   scrolled past via `value = 1`), compact 32px category section headers, and
 *   large-font (28px) single-line task tiles
 * - Local File Storage (`fs`, CBOR encoding) persistence for the list catalog
 *   (`t-lists.cbor`) and per-list tasks & unsynced toggles (`t-<hash>.cbor`)
 * - Immediate render from stored `fs` cache on restart while syncing in background
 * - Timestamp-aware reconciliation (`reconcileWatchTasks`) where newer server edits win
 */
export function createWatchApp(options) {
  var doc = options.document;
  var fs = options.fs;
  var send = options.send;
  var isConnectedFn = options.isConnected || function () { return true; };
  var nowFn = options.now || function () { return Date.now(); };
  var persistDelayMs = typeof options.persistDelayMs === "number" ? options.persistDelayMs : 0;

  var statusEl = doc.getElementById("status");
  var pageHintEl = doc.getElementById("page-hint");
  var containerEl = doc.getElementById("container");
  var checklistEl = doc.getElementById("checklist");
  var listsChecklistEl = doc.getElementById("lists-checklist");
  var reassembler = createChunkReassembler();

  var taskRows = buildTaskRows([]);
  var listRows = buildListRows([]);
  var delegatesInitialized = false;
  var persistTimer = null;
  var dirtyActiveList = false;

  var state = {
    view: "lists", // "tasks" (page 0) | "lists" (page 1)
    calendars: [],
    activeCalendarHref: undefined,
    items: [],
    pending: [],
    categoryOrder: [],
    activeCategoryOrder: undefined,
    lastSyncedAt: undefined,
    syncing: false,
    syncingPending: false,
    error: "",
  };

  function applyTaskCompletedUI(tile, completed) {
    var titleEl = tile.getElementById("task-title");
    var checkboxCheck = tile.getElementById("checkbox-check");
    if (checkboxCheck && checkboxCheck.style) {
      checkboxCheck.style.display = completed ? "inline" : "none";
    }
    if (titleEl && titleEl.style) {
      titleEl.style.fill = completed ? "#9ca3af" : "#ffffff";
    }
  }

  function getEffectiveCategoryOrder() {
    return Array.isArray(state.activeCategoryOrder)
      ? state.activeCategoryOrder
      : state.categoryOrder;
  }

  function getActiveCalendarName() {
    if (!state.activeCalendarHref) return "Tasks";
    for (var i = 0; i < state.calendars.length; i++) {
      if (state.calendars[i].href === state.activeCalendarHref) {
        return state.calendars[i].displayName;
      }
    }
    return "Tasks";
  }

  function computeListSubtitle(calendarHref) {
    var stored = readListStore(fs, calendarHref);
    if (!stored) {
      return "Tap to load";
    }
    if (stored.pending.length > 0) {
      return stored.pending.length + " pending";
    }
    var remaining = 0;
    for (var i = 0; i < stored.tasks.length; i++) {
      if (!stored.tasks[i].completed) remaining += 1;
    }
    if (stored.tasks.length === 0) return "Empty";
    return remaining === 0 ? "All done" : remaining + " left";
  }

  function computeStatusText() {
    if (state.error) {
      return "Err: " + state.error;
    }
    if (state.view === "lists") {
      if (!isConnectedFn()) {
        return state.calendars.length > 0 ? "Offline - Lists" : "Offline";
      }
      if (state.syncing) {
        return "Loading lists...";
      }
      if (state.calendars.length === 0) {
        return "No lists";
      }
      return "Lists (" + state.calendars.length + ")";
    }

    // Tasks view status
    if (!isConnectedFn()) {
      if (state.pending.length > 0) {
        return "Offline (" + state.pending.length + " pending)";
      }
      return "Offline";
    }
    if (state.syncing) {
      return "Syncing...";
    }
    if (state.pending.length > 0) {
      return state.syncingPending
        ? "Saving (" + state.pending.length + ")..."
        : state.pending.length + " unsynced";
    }
    if (state.items.length === 0) {
      return "No items";
    }
    var remaining = 0;
    for (var i = 0; i < state.items.length; i++) {
      if (!state.items[i].completed) remaining += 1;
    }
    return remaining === 0 ? "All done!" : remaining + " left";
  }

  function renderHeader() {
    if (statusEl) {
      statusEl.text = computeStatusText();
    }
    if (pageHintEl) {
      if (state.view === "tasks") {
        pageHintEl.text = "Lists ›";
      } else {
        pageHintEl.text = state.activeCalendarHref ? "‹ Tasks" : "";
      }
    }
  }

  function syncPanoramaPage() {
    if (!containerEl) return;
    var desired = state.view === "tasks" ? 0 : 1;
    if (containerEl.value !== desired) {
      containerEl.value = desired;
    }
  }

  function handlePanoramaChange() {
    if (!containerEl) return;
    var page = containerEl.value;
    if (page === 1 && state.view !== "lists") {
      flushPersistence();
      state.view = "lists";
      state.error = "";
      renderListsView(false);
      renderHeader();
    } else if (page === 0 && state.view !== "tasks") {
      state.view = "tasks";
      state.error = "";
      renderHeader();
    }
  }

  function initDelegates() {
    if (delegatesInitialized) return;
    delegatesInitialized = true;

    if (containerEl) {
      if (typeof containerEl.addEventListener === "function") {
        containerEl.addEventListener("select", handlePanoramaChange);
        containerEl.addEventListener("change", handlePanoramaChange);
      }
      containerEl.onvaluechange = handlePanoramaChange;
    }

    if (checklistEl) {
      checklistEl.delegate = {
        getTileInfo: function (index) {
          var row = taskRows[index];
          if (!row) return { type: "spacer-pool", index: index };
          if (row.type === "category-pool") {
            return { type: "category-pool", category: row.category, index: index };
          }
          if (row.type === "item-pool") {
            return { type: "item-pool", taskIndex: row.taskIndex, index: index };
          }
          return { type: row.type, index: index };
        },
        configureTile: function (tile, info) {
          if (info.type === "sync-pool") {
            var labelEl = tile.getElementById("sync-label");
            if (labelEl) {
              labelEl.text = state.syncing ? "Syncing..." : "Sync Now";
            }
            var syncTouch = tile.getElementById("sync-touch");
            if (syncTouch) {
              syncTouch.onclick = function () {
                requestSync();
              };
            }
          } else if (info.type === "category-pool") {
            var catEl = tile.getElementById("category-title");
            if (catEl) {
              catEl.text = info.category || "";
            }
          } else if (info.type === "item-pool") {
            var item = state.items[info.taskIndex];
            if (!item) return;
            var titleEl = tile.getElementById("task-title");
            if (titleEl) {
              titleEl.text = item.summary;
            }
            applyTaskCompletedUI(tile, item.completed);
            tile.__taskIndex = info.taskIndex;
            var touchEl = tile.getElementById("task-touch");
            if (touchEl) {
              touchEl.onclick = function () {
                toggleTask(tile.__taskIndex, tile);
              };
            }
          }
        },
      };
    }

    if (listsChecklistEl) {
      listsChecklistEl.delegate = {
        getTileInfo: function (index) {
          var row = listRows[index];
          if (!row) return { type: "lists-spacer-pool", index: index };
          if (row.type === "list-pool") {
            return { type: "list-pool", listIndex: row.listIndex, index: index };
          }
          return { type: row.type, index: index };
        },
        configureTile: function (tile, info) {
          if (info.type === "lists-sync-pool") {
            var labelEl = tile.getElementById("sync-label");
            if (labelEl) {
              labelEl.text = state.syncing ? "Syncing..." : "Sync Lists";
            }
            var syncTouch = tile.getElementById("sync-touch");
            if (syncTouch) {
              syncTouch.onclick = function () {
                requestSync();
              };
            }
          } else if (info.type === "list-pool") {
            var cal = state.calendars[info.listIndex];
            if (!cal) return;
            var titleEl = tile.getElementById("list-title");
            var subEl = tile.getElementById("list-subtitle");
            if (titleEl) {
              titleEl.text = cal.displayName;
            }
            if (subEl) {
              subEl.text = computeListSubtitle(cal.href);
            }
            tile.__listHref = cal.href;
            var touchEl = tile.getElementById("list-touch");
            if (touchEl) {
              touchEl.onclick = function () {
                if (tile.__listHref) {
                  selectList(tile.__listHref);
                }
              };
            }
          }
        },
      };
    }
  }

  function renderTasksView(resetScroll) {
    initDelegates();
    taskRows = buildTaskRows(state.items);
    if (checklistEl) {
      checklistEl.length = taskRows.length;
      if (resetScroll) {
        // Start scrolled past row 0 (Sync tile) so row 1 (28px spacer) aligns
        // row 2 cleanly below the 28px status bar. When empty, leave Sync visible.
        checklistEl.value = state.items.length > 0 ? 1 : 0;
      }
    }
  }

  function renderListsView(resetScroll) {
    initDelegates();
    listRows = buildListRows(state.calendars);
    if (listsChecklistEl) {
      listsChecklistEl.length = listRows.length;
      if (resetScroll) {
        listsChecklistEl.value = state.calendars.length > 0 ? 1 : 0;
      }
    }
  }

  function render(options) {
    var resetTasksScroll = Boolean(options && options.resetTasksScroll);
    var resetListsScroll = Boolean(options && options.resetListsScroll);
    syncPanoramaPage();
    renderHeader();
    renderTasksView(resetTasksScroll);
    renderListsView(resetListsScroll);
  }

  function persistIndex() {
    writeListsIndex(fs, state);
  }

  function persistActiveList() {
    if (!state.activeCalendarHref) return;
    writeListStore(
      fs,
      state.activeCalendarHref,
      state.items,
      state.pending,
      state.lastSyncedAt,
      state.activeCategoryOrder,
    );
  }

  function flushPersistence() {
    if (persistTimer !== null) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    if (dirtyActiveList) {
      dirtyActiveList = false;
      persistActiveList();
    }
  }

  function schedulePersistActiveList() {
    dirtyActiveList = true;
    if (persistDelayMs > 0 && typeof setTimeout === "function") {
      if (persistTimer !== null) {
        clearTimeout(persistTimer);
      }
      persistTimer = setTimeout(function () {
        persistTimer = null;
        flushPersistence();
      }, persistDelayMs);
    } else {
      flushPersistence();
    }
  }

  function sendPendingToggles(calendarHref, toggles) {
    if (!isConnectedFn()) return;
    for (var i = 0; i < toggles.length; i++) {
      var entry = toggles[i];
      send({
        type: "UPDATE_TASK",
        uid: entry.uid,
        completed: entry.completed,
        calendarHref: calendarHref,
        updatedAt: entry.updatedAt,
      });
    }
  }

  function selectList(calendarHref) {
    if (!calendarHref) return;
    flushPersistence();
    state.activeCalendarHref = calendarHref;
    state.view = "tasks";
    state.syncingPending = false;
    state.error = "";

    var stored = readListStore(fs, calendarHref);
    if (stored) {
      state.activeCategoryOrder = stored.categoryOrder;
      state.items = sortTasksByCategory(stored.tasks, getEffectiveCategoryOrder());
      state.pending = stored.pending;
      state.lastSyncedAt = stored.lastSyncedAt;
    } else {
      state.activeCategoryOrder = undefined;
      state.items = [];
      state.pending = [];
      state.lastSyncedAt = undefined;
    }

    persistIndex();

    if (isConnectedFn()) {
      state.syncing = true;
      render({ resetTasksScroll: true });
      send({ type: "FETCH_TASKS", calendarHref: calendarHref });
    } else {
      state.syncing = false;
      render({ resetTasksScroll: true });
    }
  }

  function openListsView() {
    if (state.view === "lists") {
      syncPanoramaPage();
      return;
    }
    flushPersistence();
    state.view = "lists";
    state.error = "";
    if (isConnectedFn()) {
      state.syncing = true;
      render({ resetListsScroll: true });
      send({ type: "FETCH_LISTS" });
    } else {
      state.syncing = false;
      render({ resetListsScroll: true });
    }
  }

  function goBack() {
    var onListsPage = containerEl ? containerEl.value === 1 : state.view === "lists";
    if (onListsPage && state.activeCalendarHref) {
      state.view = "tasks";
      state.syncing = false;
      state.error = "";
      syncPanoramaPage();
      renderHeader();
      return true;
    }
    return false;
  }

  function toggleTask(idx, tileEl) {
    if (idx < 0 || idx >= state.items.length) return;
    var target = state.items[idx];
    var nextCompleted = !target.completed;
    var timestamp = nowFn();
    var updated = applyOptimisticToggle(
      state.items,
      state.pending,
      target.uid,
      nextCompleted,
      timestamp,
    );
    state.items = updated.tasks;
    state.pending = updated.pending;
    state.syncingPending = false;
    state.error = "";

    // Instant O(1) update of only the tapped tile and status bar —
    // no VirtualTileList length reset, no scroll jump, and no blocking BLE round-trip.
    if (tileEl) {
      applyTaskCompletedUI(tileEl, nextCompleted);
    } else {
      renderTasksView(false);
    }
    renderHeader();

    schedulePersistActiveList();
  }

  function requestSync() {
    flushPersistence();
    state.error = "";
    if (!isConnectedFn()) {
      state.syncing = false;
      state.syncingPending = false;
      render({
        resetTasksScroll: state.items.length > 0,
        resetListsScroll: state.calendars.length > 0,
      });
      return;
    }

    state.syncing = true;
    renderHeader();

    var onTasksPage = containerEl ? containerEl.value === 0 : state.view === "tasks";
    if (onTasksPage && state.activeCalendarHref) {
      state.view = "tasks";
      send({ type: "FETCH_TASKS", calendarHref: state.activeCalendarHref });
      if (state.calendars.length === 0) {
        send({ type: "FETCH_LISTS" });
      }
    } else {
      send({ type: "FETCH_LISTS" });
    }
  }

  function onMessage(data) {
    if (!data || typeof data !== "object") return;

    if (data.type === "LISTS_PAYLOAD") {
      state.error = "";
      if (Array.isArray(data.calendars)) {
        state.calendars = data.calendars.slice();
      }
      if (Array.isArray(data.categoryOrder)) {
        state.categoryOrder = data.categoryOrder.slice();
        if (state.items.length > 0 && !Array.isArray(state.activeCategoryOrder)) {
          state.items = sortTasksByCategory(state.items, getEffectiveCategoryOrder());
        }
      }

      // On first launch (when no list has ever been selected yet), auto-open the
      // configured default list or the sole available list.
      if (state.view === "lists" && !state.activeCalendarHref) {
        var autoTarget;
        if (data.defaultCalendarHref) {
          for (var i = 0; i < state.calendars.length; i++) {
            if (state.calendars[i].href === data.defaultCalendarHref) {
              autoTarget = data.defaultCalendarHref;
              break;
            }
          }
        }
        if (!autoTarget && state.calendars.length === 1) {
          autoTarget = state.calendars[0].href;
        }
        if (autoTarget) {
          persistIndex();
          selectList(autoTarget);
          return;
        }
      }

      if (state.view === "lists") {
        state.syncing = false;
      }
      persistIndex();
      render({ resetListsScroll: true });
    } else if (data.type === "TASKS_PAYLOAD" || data.type === "TASKS_CHUNK") {
      var payload = reassembler.accept(data);
      if (!payload) return;

      var targetHref = payload.calendarHref || state.activeCalendarHref;
      var isActive = targetHref === state.activeCalendarHref;
      var existingStore = isActive
        ? { tasks: state.items, pending: state.pending, categoryOrder: state.activeCategoryOrder }
        : readListStore(fs, targetHref) || { tasks: [], pending: [] };
      var listCategoryOrder = Array.isArray(payload.categoryOrder)
        ? payload.categoryOrder.slice()
        : existingStore.categoryOrder;
      var effectiveOrder = Array.isArray(listCategoryOrder)
        ? listCategoryOrder
        : state.categoryOrder;

      var reconciled = reconcileWatchTasks(payload.tasks, existingStore.pending);
      var sorted = sortTasksByCategory(reconciled.tasks, effectiveOrder);
      var syncedAt = nowFn();

      writeListStore(fs, targetHref, sorted, reconciled.pending, syncedAt, listCategoryOrder);

      if (isActive) {
        state.syncing = false;
        state.syncingPending = reconciled.togglesToSync.length > 0 && isConnectedFn();
        state.error = "";
        state.items = sorted;
        state.pending = reconciled.pending;
        state.activeCategoryOrder = listCategoryOrder;
        state.lastSyncedAt = syncedAt;
      }

      render({ resetTasksScroll: isActive });

      // Push only local pending toggles that survived timestamp reconciliation (newer than server)
      if (reconciled.togglesToSync.length > 0) {
        sendPendingToggles(targetHref, reconciled.togglesToSync);
      }
    } else if (data.type === "UPDATE_ACK") {
      var ackHref = data.calendarHref || state.activeCalendarHref;
      var ackMeta = {
        etag: data.etag,
        completed: data.completed,
        lastModified: data.lastModified,
      };

      if (ackHref === state.activeCalendarHref) {
        var acked = acknowledgeWatchToggle(state.items, state.pending, data.uid, ackMeta);
        state.items = acked.tasks;
        state.pending = acked.pending;
        if (state.pending.length === 0) {
          state.syncingPending = false;
        }
        state.error = "";
        persistActiveList();
        render({ resetTasksScroll: false });
      } else if (ackHref) {
        var other = readListStore(fs, ackHref);
        if (other) {
          var otherAcked = acknowledgeWatchToggle(
            other.tasks,
            other.pending,
            data.uid,
            ackMeta,
          );
          writeListStore(
            fs,
            ackHref,
            otherAcked.tasks,
            otherAcked.pending,
            other.lastSyncedAt,
            other.categoryOrder,
          );
          renderListsView(false);
        }
      }
    } else if (data.type === "ERROR") {
      state.syncing = false;
      state.syncingPending = false;
      state.error = data.message || "Sync failed";
      renderHeader();
    }
  }

  function onConnectionChange(connected) {
    if (connected) {
      requestSync();
    } else {
      state.syncing = false;
      state.syncingPending = false;
      renderHeader();
    }
  }

  function start() {
    initDelegates();

    // Immediately restore cached list catalog and last-opened list from Fitbit File Storage
    var index = readListsIndex(fs);
    if (index) {
      state.calendars = index.calendars;
      state.categoryOrder = index.categoryOrder;
      state.activeCalendarHref = index.activeCalendarHref;
      if (state.activeCalendarHref) {
        state.view = "tasks";
        var storedList = readListStore(fs, state.activeCalendarHref);
        if (storedList) {
          state.activeCategoryOrder = storedList.categoryOrder;
          state.items = sortTasksByCategory(storedList.tasks, getEffectiveCategoryOrder());
          state.pending = storedList.pending;
          state.lastSyncedAt = storedList.lastSyncedAt;
        }
      } else {
        state.view = "lists";
      }
    }

    // Render cached UI immediately (scrolled past row 0 Sync tile), then sync in background
    render({ resetTasksScroll: true, resetListsScroll: true });
    requestSync();
  }

  return {
    start: start,
    render: render,
    selectList: selectList,
    openListsView: openListsView,
    goBack: goBack,
    toggleTask: toggleTask,
    requestSync: requestSync,
    flushPersistence: flushPersistence,
    onMessage: onMessage,
    onConnectionChange: onConnectionChange,
    getState: function () {
      return {
        view: state.view,
        calendars: state.calendars.slice(),
        activeCalendarHref: state.activeCalendarHref,
        activeCalendarName: getActiveCalendarName(),
        items: state.items.slice(),
        pending: state.pending.slice(),
        categoryOrder: getEffectiveCategoryOrder().slice(),
        taskRows: taskRows.slice(),
        status: computeStatusText(),
      };
    },
  };
}
