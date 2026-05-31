/**
 * mimir-cc — entry point for the standalone Bun-compiled binary.
 *
 * Dispatches subcommands:
 *   install <server-url> [flags]
 *                            First-time install of the Mimir runtime.
 *                            Optional flags:
 *                              --user-memory-db <path>
 *                              --cartographer <path>
 *   update [server-url]      Re-run install. If the URL is omitted, recovers
 *                            it from ~/.mimir/mcp.json so testers don't have
 *                            to remember it.
 *   voice-anchor             UserPromptSubmit hook handler (boot context +
 *                            voice anchors).
 *   rules                    PreToolUse hook handler (rule engine nudges).
 *   reindex [--worker ...]   PostToolUse hook handler. Default mode forks
 *                            a worker and exits; worker mode does the
 *                            cartographer parse + server sync.
 *   user-memory-mcp          Stdio MCP server for user-memory tools.
 *
 * Anything else prints usage and exits non-zero.
 */

import { join } from "node:path";

import { readConfig } from "./config";
import { runFileContextHook } from "./file-context-hook";
import { type InstallOptions, runInstallCommand } from "./install";
import { runLogMcp } from "./log-mcp";
import { flushLogs } from "./logger";
import { runPersistHook } from "./persist-hook";
import { runPreCompactHook } from "./precompact-hook";
import { runReindexCommand } from "./reindex-hook";
import { runRetrieveHook } from "./retrieve-hook";
import { runRulesHook } from "./rules-hook";
import { runSessionStartCommand } from "./session-start-hook";
import { runUserMemoryMcp } from "./user-memory-mcp";
import { mimirHome } from "./util";
import { runVoiceAnchorHook } from "./voice-anchor";

const USAGE = [
  "Usage: mimir-cc <command> [args]",
  "",
  "Commands:",
  "  install <server-url> [--user-memory-db PATH] [--cartographer PATH]",
  "                          Install Mimir for Claude Code.",
  "  update [server-url]     Re-install (uses existing config if URL omitted).",
  "  voice-anchor            UserPromptSubmit hook (reads stdin).",
  "  retrieve                UserPromptSubmit hook: per-turn brain retrieval.",
  "  rules                   PreToolUse hook (reads stdin).",
  "  file-context            PreToolUse:Read hook: cartographer + memory injection.",
  "  reindex                 PostToolUse hook (reads stdin).",
  "  persist                 Stop hook: ship transcript delta to mimir brain.",
  "  precompact              PreCompact hook: pre-discard persistence.",
  "  session-start           SessionStart hook: full project re-index (replace mode).",
  "  user-memory-mcp         Stdio MCP server for user-memory tools.",
  "  log-mcp                 Stdio MCP server for reading plugin logs.",
].join("\n");

type McpConfig = {
  readonly mcpServers?: Record<string, { readonly url?: string }>;
};

/**
 * Recover the mimir-server base URL from a previously installed mcp.json.
 *
 * The MCP config stores the full endpoint URL (`<base>/mcp`); we strip the
 * `/mcp` suffix so `update` calls fetchSystemPrompt with the same base URL
 * the original install used.
 */
const readUrlFromExistingMcpConfig = async (): Promise<string | undefined> => {
  const mcpPath = join(mimirHome(), "mcp.json");
  const file = Bun.file(mcpPath);
  if (!(await file.exists())) return undefined;

  let parsed: McpConfig;
  try {
    parsed = (await file.json()) as McpConfig;
  } catch {
    return undefined;
  }

  const url = parsed.mcpServers?.mimir?.url;
  if (typeof url !== "string") return undefined;

  return url.replace(/\/mcp\/?$/, "");
};

type PartialOptions = {
  readonly serverUrl?: string;
  readonly userMemoryDb?: string;
  readonly cartographerBinary?: string;
};

/**
 * Parse the shared argv shape — optional positional URL plus optional
 * `--user-memory-db` / `--cartographer` flags. Used by both `install`
 * (which then requires serverUrl) and `update` (which layers the
 * partial over existing config.json).
 */
const parsePartialOptions = (rest: readonly string[]) => {
  let serverUrl: string | undefined;
  let userMemoryDb: string | undefined;
  let cartographerBinary: string | undefined;

  let i = 0;
  while (i < rest.length) {
    const arg = rest[i];
    if (arg === "--user-memory-db") {
      userMemoryDb = rest[i + 1];
      if (!userMemoryDb) return { error: "--user-memory-db requires a path" };
      i += 2;
      continue;
    }
    if (arg === "--cartographer") {
      cartographerBinary = rest[i + 1];
      if (!cartographerBinary) {
        return { error: "--cartographer requires a path" };
      }
      i += 2;
      continue;
    }
    if (arg?.startsWith("--")) {
      return { error: `unknown flag: ${arg}` } as const;
    }
    if (!serverUrl) {
      serverUrl = arg;
      i += 1;
      continue;
    }
    return { error: `unexpected argument: ${arg}` } as const;
  }

  // Construct the result explicitly typed so the inferred return type
  // of this function stays as `PartialOptions | { error: string }` —
  // without this, TS infers the spread shape too loosely and
  // downstream `"error" in result` narrowing breaks at call sites.
  const result: PartialOptions = {
    ...(serverUrl ? { serverUrl } : {}),
    ...(userMemoryDb ? { userMemoryDb } : {}),
    ...(cartographerBinary ? { cartographerBinary } : {}),
  };
  return result;
};

/**
 * Parse install args — same as the partial parser but with serverUrl
 * required. Install is the fresh-install path so there's nothing to
 * recover; the URL must be on the command line.
 */
const parseInstallArgs = (rest: readonly string[]) => {
  const partial = parsePartialOptions(rest);
  if ("error" in partial) return partial;
  if (!partial.serverUrl) {
    return { error: "server URL is required" } as const;
  }
  const result: InstallOptions = {
    serverUrl: partial.serverUrl,
    ...(partial.userMemoryDb ? { userMemoryDb: partial.userMemoryDb } : {}),
    ...(partial.cartographerBinary
      ? { cartographerBinary: partial.cartographerBinary }
      : {}),
  };
  return result;
};

/**
 * Build the InstallOptions for an `update` invocation by layering the
 * partial CLI args over the existing config.json. The result preserves
 * any field that wasn't explicitly overridden, so `update` with no
 * args is a true no-op refresh — same URL, same cartographer path,
 * same user-memory DB — and `update <url>` keeps the existing
 * cartographer and DB while only changing the URL.
 *
 * URL precedence: CLI flag > config.json > mcp.json (legacy fallback
 * for pre-config.json installs).
 */
const mergeUpdateOptions = async (partial: PartialOptions) => {
  const existing = await readConfig();
  const legacyUrl = existing ? undefined : await readUrlFromExistingMcpConfig();

  const serverUrl = partial.serverUrl ?? existing?.serverUrl ?? legacyUrl;
  if (!serverUrl) {
    return {
      error:
        "No URL provided and no existing config to recover from.\n" +
        "Run: mimir-cc update <mimir-server-url>",
    } as const;
  }

  const userMemoryDb = partial.userMemoryDb ?? existing?.userMemoryDb;
  const cartographerBinary =
    partial.cartographerBinary ?? existing?.cartographerBinary;

  const merged: InstallOptions = {
    serverUrl,
    ...(userMemoryDb ? { userMemoryDb } : {}),
    ...(cartographerBinary ? { cartographerBinary } : {}),
  };
  return merged;
};

const dispatch = async (argv: readonly string[]): Promise<number> => {
  const [command, ...rest] = argv;

  switch (command) {
    case "install": {
      const parsed = parseInstallArgs(rest);
      if ("error" in parsed) {
        console.error(`${parsed.error}\n\n${USAGE}`);
        return 1;
      }
      return runInstallCommand(parsed);
    }

    case "update": {
      // Parse partial — URL is optional for update (we recover from config).
      const partial = parsePartialOptions(rest);
      if ("error" in partial) {
        console.error(`${partial.error}\n\n${USAGE}`);
        return 1;
      }
      // Merge over existing config so unspecified fields (cartographer
      // binary, user-memory DB) are preserved across updates.
      const merged = await mergeUpdateOptions(partial);
      if ("error" in merged) {
        console.error(`Update failed: ${merged.error}`);
        return 1;
      }
      return runInstallCommand(merged);
    }

    case "voice-anchor":
      return runVoiceAnchorHook();

    case "retrieve":
      return runRetrieveHook();

    case "rules":
      return runRulesHook();

    case "file-context":
      return runFileContextHook();

    case "reindex":
      return runReindexCommand(rest);

    case "persist":
      return runPersistHook();

    case "precompact":
      return runPreCompactHook();

    case "session-start":
      return runSessionStartCommand(rest);

    case "user-memory-mcp":
      return runUserMemoryMcp();

    case "log-mcp":
      return runLogMcp();

    case undefined:
    case "":
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return command ? 0 : 1;

    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
};

const code = await dispatch(Bun.argv.slice(2));
// Drain pending log writes before exiting — without this, the most
// recent line (often the one that explains why we're returning early)
// would race the process tear-down and never hit disk.
await flushLogs();
process.exit(code);
