/**
 * Session modes, slash commands, and constants.
 */

import type * as acp from "@agentclientprotocol/sdk";

export const SESSION_MODES: acp.SessionMode[] = [
  {
    id: "code",
    name: "Code",
    description: "Full tool access — read, write, execute, search.",
  },
  {
    id: "ask",
    name: "Ask",
    description: "Conversational only — no tool execution.",
  },
  {
    id: "architect",
    name: "Architect",
    description: "Plan and reason about changes without modifying files.",
  },
];

export const DEFAULT_MODE = "code";

export const AVAILABLE_COMMANDS: acp.AvailableCommand[] = [
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
