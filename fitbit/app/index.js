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
  send: (payload) => asap.send(payload),
  isConnected: () => messaging.peerSocket.readyState === messaging.peerSocket.OPEN,
});

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
