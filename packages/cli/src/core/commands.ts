import { setConfigPath, stringifyConfig } from "./config/schema.ts";
import type { AppStore } from "./store/state.ts";

export const COMMAND_PREFIX = "/";

export const isCommand = (text: string) => text.startsWith(COMMAND_PREFIX);

const SET_USAGE = "usage: /set <key> <value>   e.g. /set agent.model opus";
const COMMANDS_HELP = "commands: /set <key> <value>, /config, /quit";
const NOT_PERSISTED = "  (this session only — config file is unreadable)";

/** Slash commands typed at the prompt. Everything else goes to the agent. */
export const attachCommands = (store: AppStore) => {
  const notice = (text: string) => store.dispatch({ type: "notice", text });

  store.listen((action) => {
    if (action.type !== "input/submit" || !isCommand(action.text)) {
      return;
    }
    const [name = "", ...args] = action.text
      .slice(COMMAND_PREFIX.length)
      .split(/\s+/);
    switch (name) {
      case "set": {
        const [path, ...rest] = args;
        const value = rest.join(" ");
        if (path === undefined || value === "") {
          notice(SET_USAGE);
          return;
        }
        const [error, next] = setConfigPath(
          store.getState().config.config,
          path,
          value,
        );
        if (error !== null) {
          notice(`✗ ${error.message}`);
          return;
        }
        store.dispatch({ type: "config/set", config: next });
        const persisted = store.getState().config.status === "ready";
        notice(`${path} = ${value}${persisted ? "" : NOT_PERSISTED}`);
        return;
      }
      case "config":
        notice(stringifyConfig(store.getState().config.config).trimEnd());
        return;
      case "quit":
        store.dispatch({ type: "app/quit" });
        return;
      default:
        notice(`unknown command /${name} — ${COMMANDS_HELP}`);
        return;
    }
  });
};
