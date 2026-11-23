import document from "document";
import * as fs from "fs";
import * as messaging from "messaging";
import { me as device } from "device";
import asap from "fitbit-asap/app";
import { createWatchApp } from "./watch-app";

if (!device.screen) device.screen = { width: 300, height: 300 };

const app = createWatchApp({
  document,
  fs,
  send: (payload) => asap.send(payload, { timeout: 15000 }),
  isConnected: () => messaging.peerSocket.readyState === messaging.peerSocket.OPEN,
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
