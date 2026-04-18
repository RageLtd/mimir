/**
 * Slash commands and parse logic.
 *
 * Session mode/thought-level catalogues no longer live here — each backend
 * owns its own catalogue under `backends/<name>/config-options.ts`, and the
 * agent layer dispatches through `buildSessionConfigOptions` in
 * `agent/index.ts`.
 */

import type * as acp from "@agentclientprotocol/sdk";

export const AVAILABLE_COMMANDS: acp.AvailableCommand[] = [
  {
    name: "model",
    description: "Switch the active model for this session.",
    input: { hint: "model ID" },
  },
  {
    name: "compact",
    description: "Clear session history and start fresh.",
  },
  {
    name: "memory search",
    description: "Search user memories for a query.",
    input: { hint: "search query" },
  },
  {
    name: "memory list",
    description: "List all stored user memories.",
  },
  {
    name: "memory store",
    description: "Store a new user memory.",
    input: { hint: "fact or preference to remember" },
  },
  {
    name: "memory delete",
    description: "Delete a user memory by ID.",
    input: { hint: "memory ID" },
  },
];

// ── Command parsing ──

export type ParsedCommand =
  | { type: "model"; modelId: string }
  | { type: "mode"; modeId: string }
  | { type: "compact" }
  | { type: "memory_search"; query: string }
  | { type: "memory_list" }
  | { type: "memory_store"; fact: string }
  | { type: "memory_delete"; id: string };

/**
 * Parse a slash command from user input.
 * Returns a typed command object, or null if the text is not a recognised
 * command (in which case it should be forwarded to the model as-is).
 */
export const parseCommand = (text: string): ParsedCommand | null => {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;

  const parts = trimmed.slice(1).split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? "";

  switch (cmd) {
    case "model":
      return { type: "model", modelId: parts.slice(1).join(" ") };
    case "mode":
      return { type: "mode", modeId: parts.slice(1).join(" ") };
    case "compact":
    case "clear":
      return { type: "compact" };
    case "memory": {
      const sub = parts[1]?.toLowerCase() ?? "";
      switch (sub) {
        case "search":
          return { type: "memory_search", query: parts.slice(2).join(" ") };
        case "list":
          return { type: "memory_list" };
        case "store":
          return { type: "memory_store", fact: parts.slice(2).join(" ") };
        case "delete":
          return { type: "memory_delete", id: parts[2] ?? "" };
        default:
          return null;
      }
    }
    default:
      return null;
  }
};
