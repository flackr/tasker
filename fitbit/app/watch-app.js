import {
  acknowledgeWatchToggle,
  applyOptimisticToggle,
  createChunkReassembler,
  reconcileWatchTasks,
  sortTasksByCategory,
} from "@tasker/core/watch";

var LISTS_INDEX_FILE = "tasker-lists.json";
var LEGACY_CACHE_FILE = "tasker-cache.json";

/**
 * Computes a short deterministic filename (ES5-safe FNV-1a 32-bit hex) for a
 * calendar's per-list storage file on Fitbit OS File Storage.
 */
export function getListCacheFilename(calendarHref) {
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
  return "tasker-list-" + hex + ".json";
}

function readJsonFile(fs, filename) {
  if (!fs || typeof fs.readFileSync !== "function") {
    return null;
  }
  try {
    var data = fs.readFileSync(filename, "json");
    if (data && typeof data === "object") {
      return data;
    }
  } catch (e) {
    // Missing file on first launch
  }
  return null;
}

function writeJsonFile(fs, filename, data) {
  if (!fs || typeof fs.writeFileSync !== "function") {
    return;
  }
  try {
    fs.writeFileSync(filename, data, "json");
  } catch (e) {
    // Ignore storage errors cleanly
  }
}

function readListsIndex(fs) {
  var data = readJsonFile(fs, LISTS_INDEX_FILE);
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
  var legacy = readJsonFile(fs, LEGACY_CACHE_FILE);
  if (legacy && legacy.calendarHref) {
    var migratedList = {
      calendarHref: legacy.calendarHref,
      tasks: Array.isArray(legacy.tasks) ? legacy.tasks : [],
      pending: Array.isArray(legacy.pending) ? legacy.pending : [],
      lastSyncedAt: legacy.lastSyncedAt,
    };
    writeJsonFile(fs, getListCacheFilename(legacy.calendarHref), migratedList);
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
  writeJsonFile(fs, LISTS_INDEX_FILE, {
    calendars: state.calendars,
    activeCalendarHref: state.activeCalendarHref,
    categoryOrder: state.categoryOrder,
  });
}

function readListStore(fs, calendarHref) {
  if (!calendarHref) return null;
  var data = readJsonFile(fs, getListCacheFilename(calendarHref));
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
  var record = {
    calendarHref: calendarHref,
    tasks: tasks,
    pending: pending,
    lastSyncedAt: lastSyncedAt,
  };
  if (Array.isArray(categoryOrder)) {
    record.categoryOrder = categoryOrder;
  }
  writeJsonFile(fs, getListCacheFilename(calendarHref), record);
}

function getCategoryLabel(task) {
  if (task && task.categories && task.categories.length > 0) {
    return task.categories[0];
  }
  return "";
}

/**
 * Creates the Fitbit Versa 2 Watch App controller (ES5-safe).
 *
 * Features:
 * - Top-level selected task list ('tasks' view) with a 'Lists' sub-view ('lists')
 *   so pressing the Versa 2 hardware Back button from a task list exits the app
 *   while remembering the selected list, and pressing Back inside the Lists
 *   sub-view returns to the remembered list
 * - Local File Storage (`fs`) persistence for the list catalog (`tasker-lists.json`)
 *   and each loaded list's contents & unsynced toggles (`tasker-list-<hash>.json`)
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
  var syncBtn = doc.getElementById("sync-btn");
  var backBtn = doc.getElementById("back-btn");
  var backBtnLabel = doc.getElementById("back-btn-label");
  var listsViewEl = doc.getElementById("lists-view");
  var tasksViewEl = doc.getElementById("tasks-view");
  var reassembler = createChunkReassembler();

  var listTileRefs = [];
  var taskTileRefs = [];
  var tilesInitialized = false;
  var persistTimer = null;
  var dirtyActiveList = false;

  var state = {
    view: "lists", // "tasks" (top-level) | "lists" (sub-view)
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

  function initTileRefs() {
    if (tilesInitialized) return;
    tilesInitialized = true;

    for (var i = 0; ; i++) {
      var listTile = doc.getElementById("list-item-" + i);
      if (!listTile) break;
      var listTileList = listTile.getElementById("list-tile-list");
      var touchEl = listTile.getElementById("list-touch") || listTileList;
      listTileRefs.push({
        tileList: listTileList,
        titleEl: listTile.getElementById("list-title"),
        subEl: listTile.getElementById("list-subtitle"),
        touchEl: touchEl,
        visible: null,
        title: null,
        subtitle: null,
      });
      (function (index) {
        touchEl.onclick = function () {
          if (state.calendars[index]) {
            selectList(state.calendars[index].href);
          }
        };
      })(i);
    }

    for (var j = 0; ; j++) {
      var taskTile = doc.getElementById("item-" + j);
      if (!taskTile) break;
      var taskTileList = taskTile.getElementById("task-tile-list");
      var checkbox = taskTile.getElementById("task-checkbox");
      taskTileRefs.push({
        tileList: taskTileList,
        checkbox: checkbox,
        categoryEl: taskTile.getElementById("item-category"),
        visible: null,
        summary: null,
        completed: null,
        category: null,
      });
      (function (index) {
        checkbox.onclick = function () {
          toggleTask(index);
        };
      })(j);
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

  function renderListsView() {
    initTileRefs();
    for (var i = 0; i < listTileRefs.length; i++) {
      var ref = listTileRefs[i];
      if (state.calendars.length <= i) {
        if (ref.visible !== false) {
          ref.tileList.style.display = "none";
          ref.visible = false;
        }
        continue;
      }
      if (ref.visible !== true) {
        ref.tileList.style.display = "inline";
        ref.visible = true;
      }
      var cal = state.calendars[i];
      var sub = computeListSubtitle(cal.href);
      if (ref.titleEl && ref.title !== cal.displayName) {
        ref.titleEl.text = cal.displayName;
        ref.title = cal.displayName;
      }
      if (ref.subEl && ref.subtitle !== sub) {
        ref.subEl.text = sub;
        ref.subtitle = sub;
      }
    }
  }

  function renderTasksView() {
    initTileRefs();
    for (var i = 0; i < taskTileRefs.length; i++) {
      var ref = taskTileRefs[i];
      if (state.items.length <= i) {
        if (ref.visible !== false) {
          ref.tileList.style.display = "none";
          ref.visible = false;
        }
        continue;
      }
      if (ref.visible !== true) {
        ref.tileList.style.display = "inline";
        ref.visible = true;
      }
      var item = state.items[i];
      var cat = getCategoryLabel(item);
      if (ref.summary !== item.summary) {
        ref.checkbox.text = item.summary;
        ref.summary = item.summary;
      }
      if (ref.completed !== item.completed) {
        ref.checkbox.value = item.completed ? 1 : 0;
        ref.completed = item.completed;
      }
      if (ref.categoryEl && ref.category !== cat) {
        ref.categoryEl.text = cat;
        ref.category = cat;
      }
    }
  }

  function render() {
    var inTasksView = state.view === "tasks";
    var showNavBtn = inTasksView || Boolean(state.activeCalendarHref);

    if (listsViewEl) {
      listsViewEl.style.display = inTasksView ? "none" : "inline";
    }
    if (tasksViewEl) {
      tasksViewEl.style.display = inTasksView ? "inline" : "none";
    }
    if (backBtn) {
      backBtn.style.display = showNavBtn ? "inline" : "none";
    }
    if (backBtnLabel) {
      backBtnLabel.style.display = showNavBtn ? "inline" : "none";
      backBtnLabel.text = inTasksView ? "Lists" : "Back";
    }
    if (statusEl) {
      statusEl.text = computeStatusText();
    }

    if (inTasksView) {
      renderTasksView();
    } else {
      renderListsView();
    }
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
      render();
      send({ type: "FETCH_TASKS", calendarHref: calendarHref });
    } else {
      state.syncing = false;
      render();
    }
  }

  function openListsView() {
    if (state.view === "lists") {
      return;
    }
    flushPersistence();
    state.view = "lists";
    state.error = "";
    if (isConnectedFn()) {
      state.syncing = true;
      render();
      send({ type: "FETCH_LISTS" });
    } else {
      state.syncing = false;
      render();
    }
  }

  function goBack() {
    if (state.view === "lists" && state.activeCalendarHref) {
      state.view = "tasks";
      state.syncing = false;
      state.error = "";
      render();
      return true;
    }
    return false;
  }

  function toggleTask(idx) {
    if (state.view !== "tasks" || idx < 0 || idx >= state.items.length) return;
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

    // Instant O(1) update of only the tapped tile and header status —
    // no 50-tile loop and no blocking Bluetooth round-trip on tap.
    // The recorded { uid, completed, updatedAt } entry is pushed on the next sync.
    var ref = taskTileRefs[idx];
    if (ref) {
      ref.completed = nextCompleted;
      ref.checkbox.value = nextCompleted ? 1 : 0;
    }
    if (statusEl) {
      statusEl.text = computeStatusText();
    }

    schedulePersistActiveList();
  }

  function requestSync() {
    flushPersistence();
    state.error = "";
    if (!isConnectedFn()) {
      state.syncing = false;
      state.syncingPending = false;
      render();
      return;
    }

    state.syncing = true;
    render();

    // When already viewing a remembered list, pull its task updates immediately
    // while keeping the cached list displayed; only fetch lists if we don't have
    // the catalog yet or are inside the Lists sub-view.
    if (state.view === "tasks" && state.activeCalendarHref) {
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
      render();
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

      render();

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
        render();
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
          if (state.view === "lists") {
            render();
          }
        }
      }
    } else if (data.type === "ERROR") {
      state.syncing = false;
      state.syncingPending = false;
      state.error = data.message || "Sync failed";
      render();
    }
  }

  function onConnectionChange(connected) {
    if (connected) {
      requestSync();
    } else {
      state.syncing = false;
      state.syncingPending = false;
      render();
    }
  }

  function start() {
    initTileRefs();
    if (syncBtn) {
      syncBtn.onclick = function () {
        requestSync();
      };
    }
    if (backBtn) {
      backBtn.onclick = function () {
        if (state.view === "tasks") {
          openListsView();
        } else {
          goBack();
        }
      };
    }

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

    // Render cached UI immediately, then sync changes in the background
    render();
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
        status: computeStatusText(),
      };
    },
  };
}
