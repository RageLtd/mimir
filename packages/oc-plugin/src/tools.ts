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
 *   - `hygieneTool()` — the `mimir_hygiene` sweep over the local
 *     replica (MIM-86). Reads the extraction credentials itself so
 *     keys never enter the model transcript.
 *
 * All are wired into the plugin entry's `Hooks.tool` field. The
 * user-memory tools graceful-degrade when the store is null
 * (uninitialised); the install tool is always callable but errors
 * when env state is wrong (e.g. MIMIR_API_KEY missing).
 */

import { join } from "node:path";
import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import { runLocalHygieneSweep } from "@mimir/plugin-core/brain/hygiene";
import { attempt } from "@mimir/plugin-core/result";
import {
  createOrgReplica,
  defaultOrgReplicaPath,
} from "@mimir/plugin-core/store/org-replica";
import type { UserMemoryStore } from "@mimir/plugin-core/store/user-memories";
import { executeCartTool } from "@mimir/plugin-core/tools/cart-tools";
import { executeUserMemoryTool } from "@mimir/plugin-core/tools/user-memory";
import { mimirHome } from "@mimir/plugin-core/util";
import { tool } from "@opencode-ai/plugin";
import { extractionConfig } from "./config";
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

/**
 * Local cartographer tools (MIM-91) — served from the local cart index
 * via the shared plugin-core executor; schemas mirror the retired server
 * /mcp versions. The `projectPath` closure supplies auto-detection (the
 * OpenCode plugin knows its project directory; process.cwd() may not be
 * it).
 */
export const cartographerTools = (projectPath: string) => ({
  cartographer_search: tool({
    description:
      "Search indexed codebase for files by path or symbol name. Omit project to auto-detect.",
    args: {
      query: tool.schema
        .string()
        .describe("Search query — matches file paths and symbol names"),
      limit: tool.schema
        .number()
        .optional()
        .describe("Maximum results (default: 10)"),
    },
    async execute(args) {
      const result = await executeCartTool("cartographer_search", {
        project: projectPath,
        query: args.query,
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      return result.isError ? `Error: ${result.content}` : result.content;
    },
  }),

  cartographer_file_info: tool({
    description:
      "Get file details: symbols, imports, and dependents. Omit project to auto-detect.",
    args: {
      file_path: tool.schema
        .string()
        .describe("Path to the file (project-relative or absolute)"),
    },
    async execute(args) {
      const result = await executeCartTool("cartographer_file_info", {
        project: projectPath,
        file_path: args.file_path,
      });
      return result.isError ? `Error: ${result.content}` : result.content;
    },
  }),

  cartographer_query: tool({
    description:
      "Walk import graph from entry points. Returns dependencies and dependents up to depth.",
    args: {
      entry_points: tool.schema
        .array(tool.schema.string())
        .describe("File paths or search terms to start from"),
      max_depth: tool.schema
        .number()
        .optional()
        .describe("Maximum hops (default: 2)"),
      max_results: tool.schema
        .number()
        .optional()
        .describe("Maximum files (default: 20)"),
    },
    async execute(args) {
      const result = await executeCartTool("cartographer_query", {
        project: projectPath,
        entry_points: args.entry_points,
        ...(args.max_depth !== undefined ? { max_depth: args.max_depth } : {}),
        ...(args.max_results !== undefined
          ? { max_results: args.max_results }
          : {}),
      });
      return result.isError ? `Error: ${result.content}` : result.content;
    },
  }),
});

// Shared with the cc-plugin's hygiene command — both sweep the SAME local
// replica, so the untouched-decay clock must be one clock.
const hygieneStatePath = () => join(mimirHome(), "hygiene-state.json");

const readLastSweepMs = async () => {
  const file = Bun.file(hygieneStatePath());
  if (!(await file.exists())) return null;
  const [err, parsed] = await attempt(
    async () => (await file.json()) as { lastSweepMs?: number },
  );
  if (err || typeof parsed.lastSweepMs !== "number") return null;
  return parsed.lastSweepMs;
};

type LocalSweepReport = Awaited<ReturnType<typeof runLocalHygieneSweep>>;

const formatSweepReport = (report: LocalSweepReport) => {
  const merged = report.proposals.filter((p) => p.applied).length;
  const contradictionsApplied = report.contradictions.filter(
    (c) => c.applied,
  ).length;
  const lines = [
    `Hygiene sweep ${report.dryRun ? "dry run" : "LIVE run"} complete (model ${report.model}, ${report.facts} memories).`,
    `- Consolidation: ${report.clustersFound} cluster(s) found, ${merged} merged`,
    `- Contradiction: ${report.contradictions.length} pair(s) judged, ${contradictionsApplied} applied`,
    `- Forgetting: ${report.pruned} pruned of ${report.pruneCandidates.length} candidate(s), ${report.decayed} decayed`,
  ];
  if (report.dryRun) {
    lines.push("Nothing was mutated — rerun with live: true to apply.");
  }
  return lines.join("\n");
};

/**
 * The `mimir_hygiene` tool — run the memory hygiene sweep over the LOCAL
 * replica (MIM-86; formerly POSTed to the server's /v1/hygiene/sweep,
 * which is gone). Judgment model is the extraction trio (MIMIR_EXTRACTION_*),
 * `model` overriding just the model id. Last-sweep state (drives
 * untouched-decay) is shared with the cc-plugin at ~/.mimir/hygiene-state.json
 * and only advances on live runs.
 */
export const hygieneTool = () =>
  tool({
    description:
      "Run a memory hygiene sweep over the local memory replica — consolidate near-duplicate memories, demote contradicted facts, prune stale ones. Dry-run by default (reports what WOULD change without mutating); pass live: true only when the user explicitly asked to apply. Can take a few minutes.",
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
          "Judgment model id override. Defaults to the configured extraction model.",
        ),
    },
    async execute(args) {
      const base = await extractionConfig();
      if (!base) {
        return (
          "Hygiene needs an extraction endpoint: set MIMIR_EXTRACTION_BASE_URL " +
          "(and MIMIR_EXTRACTION_MODEL or MIMIR_SMALL_MODEL), or the " +
          "config.json extraction fields."
        );
      }
      const config = args.model ? { ...base, model: args.model } : base;
      const live = args.live === true;

      const [err, report] = await attempt(async () => {
        const replica = createOrgReplica(
          process.env.MIMIR_ORG_REPLICA_DB ?? defaultOrgReplicaPath(),
        );
        const lastSweepMs = await readLastSweepMs();
        const result = await runLocalHygieneSweep({
          replica,
          config,
          embed: createEmbedQuery(),
          dryRun: !live,
          lastSweepMs,
        });
        replica.close();
        return result;
      });

      if (err) return `Hygiene sweep failed: ${err.message}`;

      if (live) {
        await Bun.write(
          hygieneStatePath(),
          JSON.stringify({ lastSweepMs: Date.now() }),
        );
      }
      return formatSweepReport(report);
    },
  });
