import { settingsStorage } from "settings";
import asap from "fitbit-asap/companion";
import { createCompanionSync } from "./sync";

const companion = createCompanionSync({
  settingsStorage,
  send: (payload) => asap.send(payload),
});

asap.onmessage = (data) => {
  companion.onMessage(data);
};

settingsStorage.onchange = () => {
  companion.handleFetchTasks();
};
