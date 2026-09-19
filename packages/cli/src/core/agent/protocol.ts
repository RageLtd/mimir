import type { McpServerEntry } from "@mimir/plugin-core/mcp/config-file";
import type { PermissionMode } from "../config/schema.ts";
import type { LocalPlugin } from "../resources/plugins.ts";

/** Main → agent worker. Replies come back as `agent/*` and `permission/*` actions. */
export type AgentCommand =
  | {
      type: "agent/start";
      model?: string;
      permissionMode: PermissionMode;
      mcpServers: Record<string, McpServerEntry>;
      plugins: LocalPlugin[];
    }
  | { type: "agent/send"; text: string }
  | { type: "agent/permission"; id: string; behavior: "allow" | "deny" }
  | { type: "agent/close" };
