import { attachAgent } from "./agent/bridge.ts";
import { attachCommands } from "./commands.ts";
import { attachConfigPersistence } from "./config/persist.ts";
import { registerConfigSlice } from "./config/reducer.ts";
import { attachIo } from "./io/bridge.ts";
import { attachPermissionsPersistence } from "./permissions/persist.ts";
import { registerPermissionsSlice } from "./permissions/reducer.ts";
import type { PermissionDecision } from "./permissions/rules.ts";
import { attachResources } from "./resources/attach.ts";
import { registerResourcesSlice } from "./resources/reducer.ts";
import type { AppState, AppStore } from "./store/state.ts";
import { createStore } from "./store/store.ts";
import { registerTranscriptSlice } from "./transcript/reducer.ts";

/**
 * The whole contract between the behaviour layer and any frontend (TUI,
 * print, an IPC bridge for a GUI host). Frontends read state through
 * `getState`/`subscribe` and act only through the named methods — they never
 * see the store or dispatch raw actions. Everything crossing this line is
 * plain JSON-serialisable data, so it can also cross a process boundary.
 */
export type App = {
  getState: () => AppState;
  subscribe: AppStore["subscribe"];
  submit: (text: string) => void;
  answerPermission: (id: string, decision: PermissionDecision) => void;
  quit: () => void;
  /** Fires after each completed agent turn. */
  onTurnEnd: (listener: () => void) => () => void;
  /** Fires once the app is shutting down; workers are already stopping. */
  onQuit: (listener: () => void) => () => void;
};

export type Frontend = (app: App) => Promise<void>;

export const createApp = (cwd = process.cwd()) => {
  const store = createStore<AppState>();
  registerConfigSlice(store);
  registerPermissionsSlice(store);
  registerResourcesSlice(store);
  registerTranscriptSlice(store);
  attachCommands(store);
  const io = attachIo(store);
  attachConfigPersistence(store, io);
  attachPermissionsPersistence(store, io);
  attachResources(store, io, cwd);
  attachAgent(store);

  const onActionType =
    (type: "agent/turn-end" | "app/quit") => (listener: () => void) =>
      store.listen((action) => {
        if (action.type === type) {
          listener();
        }
      });

  const app: App = {
    getState: store.getState,
    subscribe: store.subscribe,
    submit: (text) => store.dispatch({ type: "input/submit", text }),
    answerPermission: (id, decision) =>
      store.dispatch({ type: "permission/answered", id, decision }),
    quit: () => store.dispatch({ type: "app/quit" }),
    onTurnEnd: onActionType("agent/turn-end"),
    onQuit: onActionType("app/quit"),
  };
  return app;
};
