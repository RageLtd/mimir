/**
 * mimir-codex-bin — entry point for the standalone Bun-compiled binary.
 *
 * Dispatches subcommands:
 *   install <server-url> [flags]
 *                            First-time install of the Mimir runtime for
 *                            Codex CLI (config.toml, hooks + trust,
 *                            AGENTS.md persona, wrapper).
 *   update [server-url]      Re-run install, recovering options from
 *                            ~/.mimir/config.json when omitted.
 *   voice-anchor             UserPromptSubmit hook (boot context + voice
 *                            anchors).
 *   retrieve                 UserPromptSubmit hook: per-turn brain retrieval.
 *   rules                    PreToolUse hook (rule engine nudges).
 *   file-context             PreToolUse hook: cartographer + memory injection
 *                            on Bash read commands.
 *   reindex [--worker ...]   PostToolUse hook on apply_patch.
 *   persist                  Stop hook: distill the rollout delta locally.
 *   precompact               PreCompact hook: pre-discard persistence.
 *   session-start            SessionStart hook: full project re-index.
 *   user-memory-mcp          Stdio MCP server for local memory tools.
 *   log-mcp                  Stdio MCP server for reading plugin logs.
 *
 * Anything else prints usage and exits non-zero.
 */

import { runKeysCommand } from "@mimir/plugin-core/keys/cli";
import { runLocalToolsMcp } from "@mimir/plugin-core/mcp/local-tools-server";
import { runLogMcp } from "@mimir/plugin-core/mcp/logs-server";
import { runSyncCommand } from "@mimir/plugin-core/sync/cli";
import { runBackfillCommand } from "./backfill-command";
import { runFileContextHook } from "./file-context-hook";
import { runHygieneCommand } from "./hygiene-command";
import { flushLogs } from "./logger";
import { runPersistHook } from "./persist-hook";
import { runPreCompactHook } from "./precompact-hook";
import { runReindexCommand } from "./reindex-hook";
import { runRetrieveHook } from "./retrieve-hook";
import { runRulesHook } from "./rules-hook";
import { runSessionStartCommand } from "./session-start-hook";
import { runStatusCommand } from "./status-command";
import { runVoiceAnchorHook } from "./voice-anchor";

const USAGE = [
  "Usage: mimir-codex-bin <command> [args]",
  "",
  "Commands:",
  "  install <server-url> [--user-memory-db PATH] [--cartographer PATH] [--api-key KEY]",
  "                       [--provider-api-key KEY] [--provider ID] [--small-model MODEL]",
  "                       [--extraction-base-url URL] [--extraction-model MODEL]",
  "                          Install Mimir for Codex CLI. The API key may",
  "                          also come from $MIMIR_API_KEY; the BYOK provider",
  "                          key/id/model from $MIMIR_PROVIDER_API_KEY,",
  "                          $MIMIR_PROVIDER, $MIMIR_SMALL_MODEL.",
  "  update [server-url]     Re-install (uses existing config if URL omitted).",
  "  voice-anchor            UserPromptSubmit hook (reads stdin).",
  "  retrieve                UserPromptSubmit hook: per-turn brain retrieval.",
  "  rules                   PreToolUse hook (reads stdin).",
  "  file-context            PreToolUse hook: cartographer + memory injection.",
  "  reindex                 PostToolUse hook (reads stdin).",
  "  persist                 Stop hook: distill rollout delta to the local brain.",
  "  precompact              PreCompact hook: pre-discard persistence.",
  "  session-start           SessionStart hook: full project re-index (replace mode).",
  "  user-memory-mcp         Stdio MCP server for local memory tools.",
  "  log-mcp                 Stdio MCP server for reading plugin logs.",
  "  status                  Report hook trust + extraction/config health.",
  "  hygiene                 Run a local memory hygiene sweep (--live to apply, --model <id>).",
  "  embed-backfill          Vectorize org-replica memories that lack embeddings.",
  "  keys <command>          E2E key ceremonies (MIM-87): status, setup, adopt,",
  "                          rotate, recovery-setup, recover.",
  "  sync                    Pull + push org memories through the blind sync",
  "                          relay (MIM-88), including embedding backfill.",
].join("\n");

const dispatch = async (argv: readonly string[]): Promise<number> => {
  const [command, ...rest] = argv;

  switch (command) {
    case "install":
    case "update": {
      const { runInstallCli } = await import("./install-cli");
      return runInstallCli(command, rest);
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
      return runLocalToolsMcp();

    case "log-mcp":
      return runLogMcp();

    case "status":
      return runStatusCommand();

    case "hygiene":
      return runHygieneCommand(rest);

    case "embed-backfill":
      return runBackfillCommand();

    case "keys":
      // Shared editor-agnostic implementation (plugin-core) — the same
      // ceremonies are reachable from mimir-cc, mimir-acp, and the oc
      // wrapper.
      return runKeysCommand(rest);

    case "sync":
      return runSyncCommand();

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
