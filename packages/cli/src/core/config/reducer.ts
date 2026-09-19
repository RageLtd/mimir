import type { Action } from "../store/actions.ts";
import type { AppStore } from "../store/state.ts";
import { type CliConfig, DEFAULT_CONFIG } from "./schema.ts";

export type ConfigState = {
  /** `error` = the file on disk was unreadable; defaults are in effect and
   *  persistence is suspended so the bad file is never clobbered. */
  status: "loading" | "ready" | "error";
  config: CliConfig;
  /** True after a runtime edit until the io worker confirms the save. */
  dirty: boolean;
};

export const INITIAL_CONFIG_STATE: ConfigState = {
  status: "loading",
  config: DEFAULT_CONFIG,
  dirty: false,
};

export const configReducer = (state: ConfigState, action: Action) => {
  switch (action.type) {
    case "config/loaded":
      return { status: "ready" as const, config: action.config, dirty: false };
    case "config/load-failed":
      return { ...state, status: "error" as const, dirty: false };
    case "config/set":
      return { ...state, config: action.config, dirty: true };
    case "config/saved":
      return state.dirty ? { ...state, dirty: false } : state;
    default:
      return state;
  }
};

export const registerConfigSlice = (store: AppStore) => {
  store.register("config", INITIAL_CONFIG_STATE, configReducer);
};
