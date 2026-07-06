/**
 * In-process custom tools for the Mimir runtime.
 *
 * Two tool families:
 *
 *   - `userMemoryTools(store)` — the seven user-memory tools
 *     (search/store/list/delete × profile × memory). Mirrors what the
 *     cc-plugin exposes via stdio MCP; OpenCode loads them as
 *     in-process custom tools with no MCP round-trip.
 *
 *   - `installTool()` — the `/mimir-install` slash command's
 *     `mimir_install` tool. Calls `installMimir` from ./install.ts
 *     with the user's parameters. Returns a status report.
 *
 * Both are wired into the plugin entry's `Hooks.tool` field. The
 * user-memory tools graceful-degrade when the store is null
 * (uninitialised); the install tool is always callable but errors
 * when env state is wrong (e.g. MIMIR_API_KEY missing).
 */

import type { UserMemoryStore } from "@mimir/plugin-core/store/user-memories";
import { executeUserMemoryTool } from "@mimir/plugin-core/tools/user-memory";
import { tool } from "@opencode-ai/plugin";
import { installMimir } from "./install";

export const userMemoryTools = (store: UserMemoryStore | null) => ({
  user_memory_search: tool({
    description:
      "Search facts about the developer themselves — preferences, setup, opinions, life circumstances, past decisions they've made, frustrations. Use when the developer mentions something about their workflow, environment, or history that might have context worth recalling, when a preference they've expressed before seems relevant to the current task, or when you want to check whether you already know something about them before asking. This store is user-scoped across all projects — use project_memory_search for facts about the current codebase instead.",
    args: {
      query: tool.schema
        .string()
        .describe("Search query to match against stored memories"),
    },
    async execute(args) {
      if (!store) {
        return "User memory unavailable: store not initialised. Run /mimir-install first.";
      }
      const result = executeUserMemoryTool(store, "user_memory_search", {
        query: args.query,
      });
      if (result.isError) return `Error: ${result.content}`;
      return result.content;
    },
  }),

  user_memory_store: tool({
    description:
      "Store a new fact about the developer. Call proactively whenever they reveal something about themselves — preferences, opinions, life circumstances, health conditions, frustrations, personal history, technical decisions, or anything worth remembering next session. No explicit 'remember this' required; if it's worth knowing across future sessions, store it now. User-scoped across all projects — facts about the current codebase belong in project_memory_store instead.",
    args: {
      content: tool.schema
        .string()
        .describe(
          "The fact to remember — a single, self-contained statement (e.g. 'Has ADHD', 'Frustrated with current employer', 'Prefers dark themes', 'Partner is pregnant')",
        ),
    },
    async execute(args) {
      if (!store) {
        return "User memory unavailable: store not initialised. Run /mimir-install first.";
      }
      const result = executeUserMemoryTool(store, "user_memory_store", {
        content: args.content,
      });
      if (result.isError) return `Error: ${result.content}`;
      return result.content;
    },
  }),

  user_memory_list: tool({
    description:
      "List all stored facts about the developer. Use to get an overview of what is known about them, find the ID of a specific memory for update or deletion, or audit the store when context is thin.",
    args: {},
    async execute() {
      if (!store) {
        return "User memory unavailable: store not initialised. Run /mimir-install first.";
      }
      const result = executeUserMemoryTool(store, "user_memory_list", {});
      if (result.isError) return `Error: ${result.content}`;
      return result.content;
    },
  }),

  user_memory_delete: tool({
    description:
      "Delete a developer memory by ID. Use when a stored fact is no longer accurate, has been superseded, or the developer asks you to forget it. Confirm the content with them before calling unless they explicitly requested deletion.",
    args: {
      id: tool.schema.number().int().describe("The ID of the memory to delete"),
    },
    async execute(args) {
      if (!store) {
        return "User memory unavailable: store not initialised. Run /mimir-install first.";
      }
      const result = executeUserMemoryTool(store, "user_memory_delete", {
        id: args.id,
      });
      if (result.isError) return `Error: ${result.content}`;
      return result.content;
    },
  }),

  user_profile_get: tool({
    description:
      "Get the developer's profile — stable identity facts like name, role, location, editor, communication preferences. Use when you need to reference their setup or preferences and the ambient <user_context> block isn't sufficient.",
    args: {},
    async execute() {
      if (!store) {
        return "User memory unavailable: store not initialised. Run /mimir-install first.";
      }
      const result = executeUserMemoryTool(store, "user_profile_get", {});
      if (result.isError) return `Error: ${result.content}`;
      return result.content;
    },
  }),

  user_profile_add: tool({
    description:
      "Add an entry to the developer's profile. Use for stable identity facts: name, role, location, health conditions, communication preferences, editor/tool setup, household details, hobbies, philosophical outlook — anything that defines who they are rather than what happened in a specific session. Ephemeral facts belong in user_memory_store instead.",
    args: {
      content: tool.schema
        .string()
        .describe(
          "The profile fact to store (e.g. 'Name: Alex', 'Has ADHD — prefers direct communication', 'HEMA practitioner', 'Lives in Vancouver with partner and dog')",
        ),
    },
    async execute(args) {
      if (!store) {
        return "User memory unavailable: store not initialised. Run /mimir-install first.";
      }
      const result = executeUserMemoryTool(store, "user_profile_add", {
        content: args.content,
      });
      if (result.isError) return `Error: ${result.content}`;
      return result.content;
    },
  }),

  user_profile_remove: tool({
    description:
      "Remove a profile entry by ID. Use when a profile fact is outdated, wrong, or the developer corrects it. Find the target ID via user_profile_get.",
    args: {
      id: tool.schema
        .number()
        .int()
        .describe("The ID of the profile entry to remove"),
    },
    async execute(args) {
      if (!store) {
        return "User memory unavailable: store not initialised. Run /mimir-install first.";
      }
      const result = executeUserMemoryTool(store, "user_profile_remove", {
        id: args.id,
      });
      if (result.isError) return `Error: ${result.content}`;
      return result.content;
    },
  }),
});

/**
 * The install tool. Wired into the plugin entry's `Hooks.tool` field.
 *
 * Validates env state (MIMIR_API_KEY), fetches the system prompt from
 * the server, writes the runtime files. The slash command at
 * `commands/mimir-install.md` is what the user invokes to trigger
 * this — the model reads the markdown, gathers the parameters from
 * the user, and calls this tool.
 */
export const installTool = () =>
  tool({
    description:
      "Install Mimir for OpenCode. Writes the system prompt, Mimir config, OpenCode config, custom agent, and wrapper script to the user's home directory. The Mimir plugin bundle must already be at ~/.config/opencode/plugins/mimir-oc.ts — the install verifies this and refuses to proceed if missing. The cloud server requires MIMIR_API_KEY in the environment; check that first before calling.",
    args: {
      serverUrl: tool.schema
        .string()
        .describe(
          "Base URL of the mimir-server (e.g. 'https://mimir.rageltd.ca')",
        ),
      userMemoryDb: tool.schema
        .string()
        .optional()
        .describe(
          "Filesystem path for the SQLite user-memory store. Defaults to ~/.mimir/user-memories.db.",
        ),
      cartographerBinary: tool.schema
        .string()
        .optional()
        .describe(
          "Absolute path to the cartographer Rust binary. Omit to disable auto-reindex.",
        ),
      apiKey: tool.schema
        .string()
        .optional()
        .describe(
          "Mimir server API key. Defaults to $MIMIR_API_KEY from the environment.",
        ),
    },
    async execute(args) {
      const result = await installMimir({
        serverUrl: args.serverUrl,
        ...(args.userMemoryDb ? { userMemoryDb: args.userMemoryDb } : {}),
        ...(args.cartographerBinary
          ? { cartographerBinary: args.cartographerBinary }
          : {}),
        ...(args.apiKey ? { apiKey: args.apiKey } : {}),
      });
      if (!result.ok) {
        return `Install failed: ${result.message}`;
      }
      return result.message;
    },
  });
