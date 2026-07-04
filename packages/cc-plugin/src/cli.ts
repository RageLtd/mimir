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

import {
  mergeUpdateOptions,
  parseInstallArgs,
  parsePartialOptions,
} from "./cli-args";
import { runFileContextHook } from "./file-context-hook";
import { runInstallCommand } from "./install";
import { runLogMcp } from "./log-mcp";
import { flushLogs } from "./logger";
import { runPersistHook } from "./persist-hook";
import { runPreCompactHook } from "./precompact-hook";
import { runReindexCommand } from "./reindex-hook";
import { runRetrieveHook } from "./retrieve-hook";
import { runRulesHook } from "./rules-hook";
import { runSessionStartCommand } from "./session-start-hook";
import { runUserMemoryMcp } from "./user-memory-mcp";
import { runVoiceAnchorHook } from "./voice-anchor";

const USAGE = [
  "Usage: mimir-cc <command> [args]",
  "",
  "Commands:",
  "  install <server-url> [--user-memory-db PATH] [--cartographer PATH] [--api-key KEY]",
  "                          Install Mimir for Claude Code. The API key may",
  "                          also come from $MIMIR_API_KEY.",
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
