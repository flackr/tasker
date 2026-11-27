import { me as appbit } from "appbit";
import document from "document";
import { readFileSync, writeFileSync } from "fs";
import * as messaging from "messaging";
import { me as device } from "device";
import asap from "fitbit-asap/app";
import { createWatchApp } from "./watch-app";

if (!device.screen) device.screen = { width: 300, height: 300 };

// Wrap named fs exports directly so Rollup (interop: "auto" for Fitbit OS 4
// device modules) emits direct require("fs").readFileSync/writeFileSync calls
// instead of an _interopNamespace(Object.keys(fs)) wrapper, which fails on
// JerryScript's native fs module bindings.
const watchFs = {
  readFileSync: (filename, encoding) => readFileSync(filename, encoding),
  writeFileSync: (filename, data, encoding) => writeFileSync(filename, data, encoding),
};

const app = createWatchApp({
  document,
  fs: watchFs,
  send: (payload) => asap.send(payload, { timeout: 15000 }),
  isConnected: () => messaging.peerSocket.readyState === messaging.peerSocket.OPEN,
  persistDelayMs: 350,
});

// Flush any debounced local fs writes before the app exits
appbit.addEventListener("unload", () => {
  app.flushPersistence();
});

// Intercept Versa 2 hardware back button only inside the Lists sub-view so
// pressing Back from the top-level task list exits the app cleanly.
document.onkeypress = (evt) => {
  if (evt && evt.key === "back") {
    if (app.goBack()) {
      evt.preventDefault();
    }
  }
};

asap.onmessage = (data) => {
  app.onMessage(data);
};

messaging.peerSocket.addEventListener("open", () => {
  app.onConnectionChange(true);
});

messaging.peerSocket.addEventListener("close", () => {
  app.onConnectionChange(false);
});

app.start();
