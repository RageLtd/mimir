import type { McpServerEntry } from "@mimir/plugin-core/mcp/config-file";
import type { CliConfig } from "../config/schema.ts";
import type {
  AllowRule,
  PermissionDecision,
  PermissionRequest,
} from "../permissions/rules.ts";
import type { LayerReport } from "../resources/loader.ts";
import type { LocalPlugin } from "../resources/plugins.ts";

/**
 * Every state change in the app is one of these. Workers post them back to
 * the main thread verbatim, so this union is also the worker → main protocol.
 */
export type Action =
  | { type: "config/loaded"; config: CliConfig }
  | { type: "config/load-failed"; error: string }
  | { type: "config/set"; config: CliConfig }
  | { type: "config/saved" }
  | { type: "config/save-failed"; error: string }
  | { type: "permissions/loaded"; rules: AllowRule[] }
  | { type: "permissions/load-failed"; error: string }
  | { type: "permissions/saved" }
  | { type: "permissions/save-failed"; error: string }
  | { type: "permission/requested"; request: PermissionRequest }
  | { type: "permission/cancelled"; id: string }
  | { type: "permission/answered"; id: string; decision: PermissionDecision }
  | {
      type: "resources/loaded";
      projectRoot: string;
      mcpServers: Record<string, McpServerEntry>;
      plugins: LocalPlugin[];
      reports: LayerReport[];
    }
  | { type: "input/submit"; text: string }
  | { type: "notice"; text: string }
  | { type: "agent/text-delta"; text: string }
  | { type: "agent/block-end" }
  | { type: "agent/tool-use"; name: string }
  | { type: "agent/turn-end" }
  | { type: "agent/error"; message: string }
  | { type: "worker/error"; worker: string; message: string }
  | { type: "app/quit" };

export type ActionType = Action["type"];
