import {
  acknowledgeWatchToggle,
  applyOptimisticToggle,
  createChunkReassembler,
  mergeWatchTasks,
  sortTasksByAisle,
} from "@tasker/core/watch";

var CACHE_FILE = "tasker-cache.json";

function readCache(fs) {
  if (!fs || typeof fs.readFileSync !== "function") {
    return null;
  }
  try {
    var data = fs.readFileSync(CACHE_FILE, "json");
    if (data && typeof data === "object") {
      return {
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
        pending: Array.isArray(data.pending) ? data.pending : [],
        aisleOrder: Array.isArray(data.aisleOrder) ? data.aisleOrder : [],
        calendarHref: data.calendarHref,
      };
    }
  } catch (e) {
    // Missing cache file on first launch
  }
  return null;
}

function writeCache(fs, state) {
  if (!fs || typeof fs.writeFileSync !== "function") {
    return;
  }
  try {
    fs.writeFileSync(
      CACHE_FILE,
      {
        tasks: state.items,
        pending: state.pending,
        aisleOrder: state.aisleOrder,
        calendarHref: state.calendarHref,
      },
      "json",
    );
  } catch (e) {
    // Ignore storage quota errors cleanly
  }
}

function getAisleLabel(task) {
  if (task && task.categories && task.categories.length > 0) {
    return task.categories[0];
  }
  return "";
}

/**
 * Creates the Fitbit Versa 2 Watch App controller (ES5-safe).
 * Accepts injected `document`, `fs`, `send`, and `isConnected` so the exact
 * watch logic runs on Versa 2 hardware, in Vitest, and in the 300x300 Playwright harness.
 */
export function createWatchApp(options) {
  var doc = options.document;
  var fs = options.fs;
  var send = options.send;
  var isConnectedFn = options.isConnected || function () { return true; };

  var statusEl = doc.getElementById("status");
  var syncBtn = doc.getElementById("sync-btn");
  var reassembler = createChunkReassembler();

  var state = {
    items: [],
    pending: [],
    aisleOrder: [],
    calendarHref: undefined,
    syncing: false,
    error: "",
  };

  function computeStatusText() {
    if (state.error) {
      return "Err: " + state.error;
    }
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
      return "Saving (" + state.pending.length + ")...";
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

  function render() {
    if (statusEl) {
      statusEl.text = computeStatusText();
    }

    for (var i = 0;; i++) {
      var tile = doc.getElementById("item-" + i);
      if (!tile) break;
      var tileList = tile.getElementById("task-tile-list");
      if (state.items.length <= i) {
        tileList.style.display = "none";
        continue;
      }
      tileList.style.display = "inline";
      var checkbox = tile.getElementById("task-checkbox");
      var aisleEl = tile.getElementById("item-aisle");
      var item = state.items[i];

      checkbox.text = item.summary;
      checkbox.value = item.completed ? 1 : 0;
      if (aisleEl) {
        aisleEl.text = getAisleLabel(item);
      }

      (function (index) {
        checkbox.onclick = function () {
          toggleTask(index);
        };
      })(i);
    }
  }

  function persist() {
    writeCache(fs, state);
  }

  function flushPendingToggles() {
    if (!isConnectedFn()) return;
    for (var i = 0; i < state.pending.length; i++) {
      var entry = state.pending[i];
      send({
        type: "UPDATE_TASK",
        uid: entry.uid,
        completed: entry.completed,
        calendarHref: state.calendarHref,
      });
    }
  }

  function toggleTask(idx) {
    if (idx < 0 || idx >= state.items.length) return;
    var target = state.items[idx];
    var nextCompleted = !target.completed;
    var updated = applyOptimisticToggle(state.items, state.pending, target.uid, nextCompleted);
    state.items = updated.tasks;
    state.pending = updated.pending;
    state.error = "";
    persist();
    render();

    if (isConnectedFn()) {
      send({
        type: "UPDATE_TASK",
        uid: target.uid,
        completed: nextCompleted,
        calendarHref: state.calendarHref,
      });
    }
  }

  function requestSync() {
    state.error = "";
    if (!isConnectedFn()) {
      state.syncing = false;
      render();
      return;
    }
    state.syncing = true;
    render();
    flushPendingToggles();
    send({ type: "FETCH_TASKS", calendarHref: state.calendarHref });
  }

  function onMessage(data) {
    if (!data || typeof data !== "object") return;

    if (data.type === "TASKS_PAYLOAD" || data.type === "TASKS_CHUNK") {
      var payload = reassembler.accept(data);
      if (!payload) return;

      state.syncing = false;
      state.error = "";
      if (payload.calendarHref !== undefined) {
        state.calendarHref = payload.calendarHref;
      }
      if (payload.aisleOrder !== undefined) {
        state.aisleOrder = payload.aisleOrder.slice();
      }
      var merged = mergeWatchTasks(payload.tasks, state.pending);
      state.items = sortTasksByAisle(merged, state.aisleOrder);
      persist();
      render();
    } else if (data.type === "UPDATE_ACK") {
      var acked = acknowledgeWatchToggle(state.items, state.pending, data.uid, data.etag);
      state.items = acked.tasks;
      state.pending = acked.pending;
      state.error = "";
      persist();
      render();
    } else if (data.type === "ERROR") {
      state.syncing = false;
      state.error = data.message || "Sync failed";
      render();
    }
  }

  function onConnectionChange(connected) {
    if (connected) {
      requestSync();
    } else {
      state.syncing = false;
      render();
    }
  }

  function start() {
    if (syncBtn) {
      syncBtn.onclick = function () {
        requestSync();
      };
    }

    var cached = readCache(fs);
    if (cached) {
      state.aisleOrder = cached.aisleOrder;
      state.calendarHref = cached.calendarHref;
      state.pending = cached.pending;
      state.items = sortTasksByAisle(cached.tasks, state.aisleOrder);
    }

    render();
    requestSync();
  }

  return {
    start: start,
    render: render,
    toggleTask: toggleTask,
    requestSync: requestSync,
    onMessage: onMessage,
    onConnectionChange: onConnectionChange,
    getState: function () {
      return {
        items: state.items.slice(),
        pending: state.pending.slice(),
        aisleOrder: state.aisleOrder.slice(),
        calendarHref: state.calendarHref,
        status: computeStatusText(),
      };
    },
  };
}
