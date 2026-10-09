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
 *                            it from ~/.mimir/config.json so testers don't
 *                            have to remember it.
 *   enable | disable         Turn Mimir on/off for one project by toggling
 *                            the plugin in its .claude/settings.local.json
 *                            (desktop app path).
 *   boot-context             First-message context block (user profile +
 *                            active project), run by the hooks module.
 *   voice-anchor --session <id> --nth <n>
 *                            The n-th voice anchor of a session's rotation,
 *                            run by the hooks module on its cadence.
 *   rules                    Rule engine on a tool call (PreToolUse payload
 *                            on stdin), run by the hooks module.
 *   guard --role <r>         Role guard for workers and the coordinator,
 *                            run by the hooks module.
 *   verify                   Verify gate (hand-back or SubagentStop payload),
 *                            run by the hooks module.
 *   reindex [--worker ...]   After a file write. Default mode forks a worker
 *                            and exits; worker mode does the cartographer
 *                            parse + local index write.
 *   user-memory-mcp          Stdio MCP server for user-memory tools.
 *
 * Anything else prints usage and exits non-zero.
 */

import { runKeysCommand } from "@mimir/plugin-core/keys/cli";
import { runSyncCommand } from "@mimir/plugin-core/sync/cli";
import { runBackfillCommand } from "./backfill-command";
import { runBootContextCommand } from "./boot-context";
import {
  mergeUpdateOptions,
  parseInstallArgs,
  parsePartialOptions,
} from "./cli-args";
import { runDelegateCommand, runReviewPromptCommand } from "./delegate-command";
import { runFileContextHook } from "./file-context-hook";
import { runGuardHook } from "./guard-hook";
import { runHygieneCommand } from "./hygiene-command";
import { runInstallCommand } from "./install";
import { runLogMcp } from "./log-mcp";
import { flushLogs } from "./logger";
import { runPersistHook } from "./persist-hook";
import { runPreCompactHook } from "./precompact-hook";
import { runDisableCommand, runEnableCommand } from "./project-settings";
import { runReindexCommand } from "./reindex-hook";
import { runRetrieveHook } from "./retrieve-hook";
import { runRulesHook } from "./rules-hook";
import { runSessionStartCommand } from "./session-start-hook";
import { runUserMemoryMcp } from "./user-memory-mcp";
import { runVerifyHook } from "./verify-hook";
import { runVoiceAnchorCommand } from "./voice-anchor";

const USAGE = [
  "Usage: mimir-cc <command> [args]",
  "",
  "Commands:",
  "  install <server-url> [--user-memory-db PATH] [--cartographer PATH] [--api-key KEY]",
  "                       [--provider-api-key KEY] [--provider ID] [--small-model MODEL]",
  "                       [--extraction-base-url URL] [--extraction-model MODEL]",
  "                          Install Mimir for Claude Code. The API key may",
  "                          also come from $MIMIR_API_KEY; the BYOK provider",
  "                          key/id/model from $MIMIR_PROVIDER_API_KEY,",
  "                          $MIMIR_PROVIDER, $MIMIR_SMALL_MODEL (MIM-74).",
  "  update [server-url]     Re-install (uses existing config if URL omitted).",
  "  enable [--project DIR] [--plugin KEY]",
  "                          Turn Mimir on for a project (default: cwd): enables the",
  "                          plugin in its .claude/settings.local.json. How the Claude",
  "                          desktop app and plain `claude` sessions become Mimir.",
  "  disable [--project DIR] [--plugin KEY]",
  "                          Reverse `enable` for a project.",
  "  boot-context            First-message context block: user profile + active",
  "                          project (reads {cwd} from stdin). Run by the hooks module.",
  "  voice-anchor --session <id> --nth <n>",
  "                          The n-th voice anchor of a session's rotation. Run by",
  "                          the hooks module every MIMIR_ANCHOR_INTERVAL turns.",
  "  retrieve                Per-turn brain retrieval (reads the UserPromptSubmit",
  "                          payload from stdin). Run by the hooks module.",
  "  rules                   Rule engine on a tool call (PreToolUse payload on stdin).",
  "  file-context            Cartographer + memory injection for a Read (stdin).",
  "  guard --role <r>        Role guard (impl|test|review|coordinator) on a tool call.",
  '  verify                  Verify gate for worker "done" claims (hand-back or',
  "                          SubagentStop payload on stdin).",
  "  verify --worktree <path> [--role impl|test] [--agent <id>] [--allow-empty]",
  "                          Run the gate by hand: re-check a retained worktree, or",
  "                          (--allow-empty) the merged tree as the integration check.",
  "  delegate <start --plan <file> | status | stop>",
  "                          Turn the coordinator role on/off for this session.",
  "  review-prompt <worktree> [--title <t>]",
  "                          Print the context-free review prompt for a worker's change.",
  "  reindex                 Reindex one written file (PostToolUse payload on stdin).",
  "  persist                 Distil a turn's transcript delta (Stop payload on stdin).",
  "  precompact              Distil the undiscarded tail (PreCompact payload on stdin).",
  "  session-start           Key reconcile, org sync, full project re-index",
  "                          (SessionStart payload on stdin).",
  "  user-memory-mcp         Stdio MCP server for user-memory tools.",
  "  log-mcp                 Stdio MCP server for reading plugin logs.",
  "  hygiene                 Sweep the local org replica: consolidate, demote,",
  "                          prune (dry-run; --live to apply, --model <id>).",
  "  embed-backfill          Vectorize org-replica memories that lack embeddings (MIM-85).",
  "  keys <command>          E2E key ceremonies (MIM-87): status, setup, adopt,",
  "                          rotate, recovery-setup, recover.",
  "  sync                    Pull + push org memories through the blind sync",
  "                          relay (MIM-88), including embedding backfill.",
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

    case "enable":
      return runEnableCommand(rest);

    case "disable":
      return runDisableCommand(rest);

    case "boot-context":
      return runBootContextCommand();

    case "voice-anchor":
      return runVoiceAnchorCommand(rest);

    case "retrieve":
      return runRetrieveHook();

    case "rules":
      return runRulesHook();

    case "file-context":
      return runFileContextHook();

    case "guard":
      return runGuardHook(rest);

    case "verify":
      return runVerifyHook(rest);

    case "delegate":
      return runDelegateCommand(rest);

    case "review-prompt":
      return runReviewPromptCommand(rest);

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

    case "hygiene":
      return runHygieneCommand(rest);

    case "embed-backfill":
      return runBackfillCommand();

    case "keys":
      // Shared editor-agnostic implementation (plugin-core) — the same
      // ceremonies are reachable from mimir-acp and the oc wrapper.
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
