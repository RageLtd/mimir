/**
 * In-process custom tools for the Mimir runtime.
 *
 * Three tool families:
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
 *   - `hygieneTool()` — the `mimir_hygiene` sweep trigger (MIM-75).
 *     Reads server + provider credentials itself so keys never enter
 *     the model transcript.
 *
 * All are wired into the plugin entry's `Hooks.tool` field. The
 * user-memory tools graceful-degrade when the store is null
 * (uninitialised); the install tool is always callable but errors
 * when env state is wrong (e.g. MIMIR_API_KEY missing).
 */

import { attempt } from "@mimir/plugin-core/result";
import type { UserMemoryStore } from "@mimir/plugin-core/store/user-memories";
import { executeUserMemoryTool } from "@mimir/plugin-core/tools/user-memory";
import { tool } from "@opencode-ai/plugin";
import { authHeaders, providerByok, readConfig } from "./config";
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

/** Mirrors PROVIDER_KEY_HEADER on the server (middleware/pipeline.ts). */
const PROVIDER_KEY_HEADER = "X-Provider-Api-Key";

/** Sweeps chain multiple judgment-model calls — allow them plenty of time. */
const HYGIENE_SWEEP_TIMEOUT_MS = 600_000;

/** The server's SweepReport, loosely typed at this serialisation boundary. */
type SweepReport = {
  readonly dryRun?: boolean;
  readonly skipped?: string;
  readonly model?: string;
  readonly memoryCount?: number;
  readonly consolidation?: { merged?: number; clustersFound?: number };
  readonly contradiction?: {
    demotions?: { applied?: boolean }[];
    merges?: { applied?: boolean }[];
  };
  readonly forgetting?: { prunedCount?: number; decayedCount?: number };
  readonly elapsedMs?: number;
};

const formatSweepReport = (report: SweepReport) => {
  if (report.skipped) return `Hygiene sweep skipped: ${report.skipped}`;
  const demoted =
    report.contradiction?.demotions?.filter((d) => d.applied).length ?? 0;
  const pairMerged =
    report.contradiction?.merges?.filter((m) => m.applied).length ?? 0;
  const lines = [
    `Hygiene sweep ${report.dryRun ? "dry run" : "LIVE run"} complete (model ${report.model ?? "?"}, ${report.memoryCount ?? 0} memories, ${Math.round((report.elapsedMs ?? 0) / 1000)}s).`,
    `- Consolidation: ${report.consolidation?.clustersFound ?? 0} cluster(s) found, ${report.consolidation?.merged ?? 0} merged`,
    `- Contradiction: ${demoted} demoted, ${pairMerged} pair-merged`,
    `- Forgetting: ${report.forgetting?.prunedCount ?? 0} pruned, ${report.forgetting?.decayedCount ?? 0} decayed`,
  ];
  if (report.dryRun) {
    lines.push("Nothing was mutated — rerun with live: true to apply.");
  }
  return lines.join("\n");
};

/**
 * The `mimir_hygiene` tool — trigger a server-side memory hygiene sweep
 * (MIM-75 Part 1). In cloud mode the periodic scheduler is off
 * (triggered-only), so this is the deliberate way to run one. Credentials
 * are read HERE from env/config — the provider key never enters the model
 * transcript. Keyed sweeps run on the user's key with an explicitly named
 * judgment model; keyless sweeps use the server's env HYGIENE_MODEL.
 */
export const hygieneTool = () =>
  tool({
    description:
      "Run a memory hygiene sweep on the mimir server — consolidate near-duplicate memories, demote contradicted facts, prune stale ones. Dry-run by default (reports what WOULD change without mutating); pass live: true only when the user explicitly asked to apply. Can take a few minutes. In cloud mode the periodic sweep is off, so this is the only way hygiene runs.",
    args: {
      live: tool.schema
        .boolean()
        .optional()
        .describe(
          "Arm the sweep (mutates the memory store). Omit for a dry run.",
        ),
      model: tool.schema
        .string()
        .optional()
        .describe(
          "Judgment model for a keyed (BYOK) sweep. Defaults to the configured small model; required when a provider key is set and no small model is configured.",
        ),
    },
    async execute(args) {
      const config = await readConfig();
      if (!config?.serverUrl) {
        return "Mimir is not installed — run /mimir-install first.";
      }

      const byok = await providerByok();
      const model = args.model ?? byok?.smallModel;
      if (byok && !model) {
        return "A provider key is configured but no judgment model is named — pass model, or set MIMIR_SMALL_MODEL.";
      }

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...(await authHeaders()),
      };
      if (byok) headers[PROVIDER_KEY_HEADER] = byok.apiKey;

      const body = {
        dryRun: args.live !== true,
        ...(byok
          ? { model, ...(byok.provider ? { provider: byok.provider } : {}) }
          : {}),
      };

      const [err, report] = await attempt(async () => {
        const response = await fetch(`${config.serverUrl}/v1/hygiene/sweep`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(HYGIENE_SWEEP_TIMEOUT_MS),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "unknown error");
          throw new Error(`server returned ${response.status}: ${text}`);
        }
        return (await response.json()) as SweepReport;
      });

      if (err) return `Hygiene sweep failed: ${err.message}`;
      return formatSweepReport(report);
    },
  });
