import type { McpServerEntry } from "@mimir/plugin-core/mcp/config-file";
import type { Action } from "../store/actions.ts";
import type { AppStore } from "../store/state.ts";
import type { LayerReport } from "./loader.ts";
import type { LocalPlugin } from "./plugins.ts";

/** Everything the session needs from the filesystem before it can start. */
export type ResourcesState = {
  status: "loading" | "ready";
  projectRoot: string | null;
  mcpServers: Record<string, McpServerEntry>;
  plugins: LocalPlugin[];
  reports: LayerReport[];
};

export const INITIAL_RESOURCES: ResourcesState = {
  status: "loading",
  projectRoot: null,
  mcpServers: {},
  plugins: [],
  reports: [],
};

export const resourcesReducer = (state: ResourcesState, action: Action) => {
  switch (action.type) {
    case "resources/loaded":
      return {
        status: "ready" as const,
        projectRoot: action.projectRoot,
        mcpServers: action.mcpServers,
        plugins: action.plugins,
        reports: action.reports,
      };
    default:
      return state;
  }
};

export const registerResourcesSlice = (store: AppStore) => {
  store.register("resources", INITIAL_RESOURCES, resourcesReducer);
};
