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
      hideCompleted: Boolean(data.hideCompleted),
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
      hideCompleted: false,
    };
  }
  return null;
}

function writeListsIndex(fs, state) {
  var record = {
    calendars: sanitizeCalendars(state.calendars),
    categoryOrder: Array.isArray(state.categoryOrder) ? state.categoryOrder.slice() : [],
    hideCompleted: Boolean(state.hideCompleted),
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
 * Builds the flat content row list (category headers + visible tasks) rendered
 * beneath the fixed top spacer (index 0) and split Sync/Autohide actions row (index 1).
 */
export function buildTaskRows(items, options) {
  var hideCompleted = Boolean(options && options.hideCompleted);
  var fallbackHeader = (options && options.fallbackHeader) || "Tasks";
  var rows = [];
  if (!Array.isArray(items) || items.length === 0) {
    return rows;
  }

  var visibleIndices = [];
  var hasAnyCategory = false;
  for (var i = 0; i < items.length; i++) {
    if (hideCompleted && items[i].completed) {
      continue;
    }
    visibleIndices.push(i);
    if (getCategoryLabel(items[i])) {
      hasAnyCategory = true;
    }
  }

  if (visibleIndices.length === 0) {
    return rows;
  }

  if (!hasAnyCategory) {
    rows.push({ kind: "category", category: fallbackHeader });
  }

  var lastCategory = null;
  for (var j = 0; j < visibleIndices.length; j++) {
    var taskIndex = visibleIndices[j];
    var cat = getCategoryLabel(items[taskIndex]);
    if (hasAnyCategory) {
      var headerLabel = cat || "Uncategorized";
      if (headerLabel !== lastCategory) {
        rows.push({ kind: "category", category: headerLabel });
        lastCategory = headerLabel;
      }
    }
    rows.push({ kind: "task", taskIndex: taskIndex });
  }
  return rows;
}

/**
 * Creates the Fitbit Versa 2 Watch App controller (ES5-safe).
 *
 * Uses static `#tile-list` elements (avoiding Fitbit OS 4's `VirtualTileList`
 * upward-scroll lockup bug) inside a native `#panoramaview` (Page 0 = Tasks,
 * swipe from right for Page 1 = Lists), with cached DOM handles for instant O(1)
 * checkbox toggles, pull-down split Sync + Autohide/Show All buttons, grouped
 * category headers, large 28px task fonts, and CBOR File Storage (`fs`).
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

  var activeListLabelEl = null;
  var syncLabelEl = null;
  var syncTouchEl = null;
  var autohideLabelEl = null;
  var autohideTouchEl = null;
  var listsSyncLabelEl = null;
  var listsSyncTouchEl = null;

  var rowRefs = [];
  var listTileRefs = [];
  var contentRows = [];
  var tilesInitialized = false;
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
    hideCompleted: false,
    lastSyncedAt: undefined,
    syncing: false,
    syncingPending: false,
    error: "",
  };

  function applyTaskCompletedUI(ref, completed) {
    if (ref.checkboxCheck && ref.checkboxCheck.style) {
      ref.checkboxCheck.style.display = completed ? "inline" : "none";
    }
    if (ref.titleEl && ref.titleEl.style) {
      ref.titleEl.style.fill = completed ? "#9ca3af" : "#ffffff";
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

  function renderHeaderAndActions() {
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
    if (activeListLabelEl) {
      activeListLabelEl.text = getActiveCalendarName();
    }
    if (syncLabelEl) {
      syncLabelEl.text = state.syncing ? "Syncing..." : "Sync";
    }
    if (autohideLabelEl) {
      autohideLabelEl.text = state.hideCompleted ? "Show All" : "Autohide";
    }
    if (autohideTouchEl && autohideTouchEl.style) {
      autohideTouchEl.style.fill = state.hideCompleted ? "#0f766e" : "#374151";
    }
    if (listsSyncLabelEl) {
      listsSyncLabelEl.text = state.syncing ? "Syncing..." : "Sync Lists";
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
      renderHeaderAndActions();
    } else if (page === 0 && state.view !== "tasks") {
      state.view = "tasks";
      state.error = "";
      renderHeaderAndActions();
    }
  }

  function initTileRefs() {
    if (tilesInitialized) return;
    tilesInitialized = true;

    if (containerEl) {
      if (typeof containerEl.addEventListener === "function") {
        containerEl.addEventListener("select", handlePanoramaChange);
        containerEl.addEventListener("change", handlePanoramaChange);
      }
      containerEl.onvaluechange = handlePanoramaChange;
    }

    var topSpacerRow = doc.getElementById("top-spacer-row");
    if (topSpacerRow) {
      activeListLabelEl = topSpacerRow.getElementById("active-list-label");
    }

    var actionsRow = doc.getElementById("actions-row");
    if (actionsRow) {
      syncLabelEl = actionsRow.getElementById("sync-label");
      syncTouchEl = actionsRow.getElementById("sync-touch");
      autohideLabelEl = actionsRow.getElementById("autohide-label");
      autohideTouchEl = actionsRow.getElementById("autohide-touch");
      if (syncTouchEl) {
        syncTouchEl.onclick = function () {
          requestSync();
        };
      }
      if (autohideTouchEl) {
        autohideTouchEl.onclick = function () {
          toggleHideCompleted();
        };
      }
    }

    var listsSyncRow = doc.getElementById("lists-sync-row");
    if (listsSyncRow) {
      listsSyncLabelEl = listsSyncRow.getElementById("lists-sync-label");
      listsSyncTouchEl = listsSyncRow.getElementById("lists-sync-touch");
      if (listsSyncTouchEl) {
        listsSyncTouchEl.onclick = function () {
          requestSync();
        };
      }
    }

    for (var i = 0; ; i++) {
      var rowEl = doc.getElementById("row-" + i);
      if (!rowEl) break;
      var ref = {
        tileList: rowEl.getElementById("row-tile-list"),
        categoryGroup: rowEl.getElementById("category-group"),
        categoryTitleEl: rowEl.getElementById("category-title"),
        taskGroup: rowEl.getElementById("task-group"),
        taskTouchEl: rowEl.getElementById("task-touch"),
        titleEl: rowEl.getElementById("task-title"),
        checkboxCheck: rowEl.getElementById("checkbox-check"),
        visible: null,
        kind: null,
        category: null,
        taskIndex: -1,
        summary: null,
        completed: null,
      };
      rowRefs.push(ref);
      if (ref.taskTouchEl) {
        (function (rowRef) {
          rowRef.taskTouchEl.onclick = function () {
            if (rowRef.kind === "task" && rowRef.taskIndex >= 0) {
              toggleTask(rowRef.taskIndex, rowRef);
            }
          };
        })(ref);
      }
    }

    for (var j = 0; ; j++) {
      var listTile = doc.getElementById("list-item-" + j);
      if (!listTile) break;
      var listTileList = listTile.getElementById("list-tile-list");
      var listTouch = listTile.getElementById("list-touch") || listTileList;
      listTileRefs.push({
        tileList: listTileList,
        titleEl: listTile.getElementById("list-title"),
        subEl: listTile.getElementById("list-subtitle"),
        touchEl: listTouch,
        visible: null,
        title: null,
        subtitle: null,
      });
      if (listTouch) {
        (function (index) {
          listTouch.onclick = function () {
            if (state.calendars[index]) {
              selectList(state.calendars[index].href);
            }
          };
        })(j);
      }
    }
  }

  function totalTasksTileCount() {
    return 2 + Math.min(contentRows.length, rowRefs.length);
  }

  function defaultTasksScrollValue() {
    // Only start scrolled past rows 0-1 (104px) onto row 2 when there are enough
    // rows (>= 8 * 52px = 416px) for row 2 to reach the top of the 300px screen
    // cleanly without half-clipping row 0 under the 28px status bar.
    return totalTasksTileCount() >= 8 ? 2 : 0;
  }

  function renderTasksView(resetScroll) {
    initTileRefs();
    contentRows = buildTaskRows(state.items, {
      hideCompleted: state.hideCompleted,
      fallbackHeader: getActiveCalendarName(),
    });

    for (var i = 0; i < rowRefs.length; i++) {
      var ref = rowRefs[i];
      if (i >= contentRows.length) {
        if (ref.visible !== false) {
          if (ref.tileList && ref.tileList.style) ref.tileList.style.display = "none";
          if (ref.categoryGroup && ref.categoryGroup.style) ref.categoryGroup.style.display = "none";
          if (ref.taskGroup && ref.taskGroup.style) ref.taskGroup.style.display = "none";
          ref.visible = false;
          ref.kind = null;
          ref.taskIndex = -1;
        }
        continue;
      }

      var row = contentRows[i];
      if (ref.visible !== true) {
        if (ref.tileList && ref.tileList.style) ref.tileList.style.display = "inline";
        ref.visible = true;
      }

      if (row.kind === "category") {
        if (ref.kind !== "category") {
          if (ref.categoryGroup && ref.categoryGroup.style) ref.categoryGroup.style.display = "inline";
          if (ref.taskGroup && ref.taskGroup.style) ref.taskGroup.style.display = "none";
          ref.kind = "category";
          ref.taskIndex = -1;
          ref.summary = null;
          ref.completed = null;
        }
        if (ref.categoryTitleEl && ref.category !== row.category) {
          ref.categoryTitleEl.text = row.category;
          ref.category = row.category;
        }
      } else {
        var item = state.items[row.taskIndex];
        if (!item) continue;
        if (ref.kind !== "task") {
          if (ref.categoryGroup && ref.categoryGroup.style) ref.categoryGroup.style.display = "none";
          if (ref.taskGroup && ref.taskGroup.style) ref.taskGroup.style.display = "inline";
          ref.kind = "task";
          ref.category = null;
        }
        ref.taskIndex = row.taskIndex;
        if (ref.titleEl && ref.summary !== item.summary) {
          ref.titleEl.text = item.summary;
          ref.summary = item.summary;
        }
        if (ref.completed !== item.completed) {
          applyTaskCompletedUI(ref, item.completed);
          ref.completed = item.completed;
        }
      }
    }

    if (checklistEl) {
      if (resetScroll) {
        checklistEl.value = defaultTasksScrollValue();
      } else if (contentRows.length === 0) {
        checklistEl.value = 0;
      }
    }
  }

  function renderListsView(resetScroll) {
    initTileRefs();
    for (var i = 0; i < listTileRefs.length; i++) {
      var ref = listTileRefs[i];
      if (state.calendars.length <= i) {
        if (ref.visible !== false) {
          if (ref.tileList && ref.tileList.style) ref.tileList.style.display = "none";
          ref.visible = false;
        }
        continue;
      }
      if (ref.visible !== true) {
        if (ref.tileList && ref.tileList.style) ref.tileList.style.display = "inline";
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
    if (listsChecklistEl && resetScroll) {
      listsChecklistEl.value = 0;
    }
  }

  function render(options) {
    var resetTasksScroll = Boolean(options && options.resetTasksScroll);
    var resetListsScroll = Boolean(options && options.resetListsScroll);
    syncPanoramaPage();
    renderTasksView(resetTasksScroll);
    renderListsView(resetListsScroll);
    renderHeaderAndActions();
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
      renderHeaderAndActions();
      return true;
    }
    return false;
  }

  function toggleHideCompleted() {
    state.hideCompleted = !state.hideCompleted;
    persistIndex();
    renderTasksView(true);
    renderHeaderAndActions();
  }

  function toggleTask(idx, rowRef) {
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

    if (state.hideCompleted && nextCompleted) {
      // Autohide active: remove the newly checked item (and empty category header) immediately
      renderTasksView(false);
    } else if (rowRef) {
      // Instant O(1) update of only the tapped tile and status bar —
      // no list rebuild, no scroll jump, and no blocking BLE round-trip.
      rowRef.completed = nextCompleted;
      applyTaskCompletedUI(rowRef, nextCompleted);
    } else {
      renderTasksView(false);
    }
    renderHeaderAndActions();

    schedulePersistActiveList();
  }

  function requestSync() {
    flushPersistence();
    state.error = "";
    if (!isConnectedFn()) {
      state.syncing = false;
      state.syncingPending = false;
      render({
        resetTasksScroll: contentRows.length > 0,
        resetListsScroll: true,
      });
      return;
    }

    state.syncing = true;
    renderHeaderAndActions();

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
      renderHeaderAndActions();
    }
  }

  function onConnectionChange(connected) {
    if (connected) {
      requestSync();
    } else {
      state.syncing = false;
      state.syncingPending = false;
      renderHeaderAndActions();
    }
  }

  function start() {
    initTileRefs();

    // Immediately restore cached list catalog, hideCompleted preference, and last-opened list
    var index = readListsIndex(fs);
    if (index) {
      state.calendars = index.calendars;
      state.categoryOrder = index.categoryOrder;
      state.activeCalendarHref = index.activeCalendarHref;
      state.hideCompleted = Boolean(index.hideCompleted);
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

    // Render cached UI immediately, then sync in background
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
    toggleHideCompleted: toggleHideCompleted,
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
        hideCompleted: state.hideCompleted,
        items: state.items.slice(),
        pending: state.pending.slice(),
        categoryOrder: getEffectiveCategoryOrder().slice(),
        taskRows: contentRows.slice(),
        status: computeStatusText(),
      };
    },
  };
}
