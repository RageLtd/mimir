import { isCommand } from "../commands.ts";
import { matchesAny, summarize } from "../permissions/rules.ts";
import type { Action } from "../store/actions.ts";
import type { AppStore } from "../store/state.ts";
import { spawnWorker } from "../workers/spawn.ts";
import type { AgentCommand } from "./protocol.ts";

const WORKER_NAME = "agent";

/**
 * Main-thread side of the agent worker. Starts the session once config has
 * resolved (loaded or fell back to defaults), forwards submitted prompts
 * (buffering any that arrive before the session is up), and relays
 * permission answers. Requests matching a persisted allow rule are answered
 * here without ever reaching the store's pending queue.
 */
export const attachAgent = (store: AppStore) => {
  const route = (action: Action) => {
    if (action.type !== "permission/requested") {
      store.dispatch(action);
      return;
    }
    const { request } = action;
    if (!matchesAny(store.getState().permissions.rules, request)) {
      store.dispatch(action);
      return;
    }
    worker.post({
      type: "agent/permission",
      id: request.id,
      behavior: "allow",
    });
    store.dispatch({
      type: "notice",
      text: `✓ auto-allowed ${request.toolName}: ${summarize(request)}`,
    });
  };

  const worker = spawnWorker<AgentCommand>(
    WORKER_NAME,
    new URL("./worker.ts", import.meta.url),
    route,
  );
  let started = false;
  const backlog: string[] = [];

  const send = (text: string) => {
    if (!started) {
      backlog.push(text);
      return;
    }
    worker.post({ type: "agent/send", text });
  };

  // The session needs both config (mode, model) and resources (MCP servers,
  // plugins); start on whichever of the two resolves last.
  const ready = () => {
    const { config, resources } = store.getState();
    return config.status !== "loading" && resources.status === "ready";
  };

  const start = () => {
    if (started || !ready()) {
      return;
    }
    const { config, resources } = store.getState();
    worker.post({
      type: "agent/start",
      model: config.config.agent.model,
      permissionMode: config.config.agent.permissionMode,
      mcpServers: resources.mcpServers,
      plugins: resources.plugins,
    });
    started = true;
    for (const text of backlog.splice(0)) {
      send(text);
    }
  };

  start();
  const unsubscribeReady = store.subscribe(ready, (isReady) => {
    if (isReady) {
      start();
      unsubscribeReady();
    }
  });

  store.listen((action) => {
    switch (action.type) {
      case "input/submit":
        if (!isCommand(action.text)) {
          send(action.text);
        }
        return;
      case "permission/answered":
        worker.post({
          type: "agent/permission",
          id: action.id,
          behavior: action.decision === "deny" ? "deny" : "allow",
        });
        return;
      case "app/quit":
        worker.post({ type: "agent/close" });
        worker.terminate();
        return;
      default:
        return;
    }
  });
};
