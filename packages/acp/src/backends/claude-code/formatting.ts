/**
 * Context formatting and SDK option building for the Claude Code backend.
 *
 * `formatContextForPrompt` renders assembled context messages as the
 * structured text body of the `load_session_context` boot tool result.
 * `buildSdkOptions` assembles the SDK Options object for `query()`. Both
 * are pure functions — straightforward to unit test.
 */

import type { ContentBlock, McpServer } from "@agentclientprotocol/sdk";
import type {
  EffortLevel,
  McpSdkServerConfigWithInstance,
  Options,
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import type { CCBackendConfig } from "../../config";
import type { RuleEntry } from "../../rules";
import { isValidCCMode } from "./config-options";
import { buildMcpServers } from "./mcp-config";
import { supportsAdaptiveThinking } from "./model-capabilities";
import { buildRuleHook } from "./rule-hooks";

/**
 * Format assembled context messages as structured text for the
 * `load_session_context` boot tool result. Same shape as the Copilot
 * backend's equivalent so model behaviour matches across backends.
 */
export const formatContextForPrompt = (
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
) => {
  if (messages.length === 0) return "";
  const lines = messages.map(
    (m) => `[${m.role === "user" ? "User" : "Assistant"}]\n${m.content}`,
  );
  return `<conversation_context>\n${lines.join("\n\n")}\n</conversation_context>`;
};

export type RunClaudeCodeOptions = {
  readonly prompt: string;
  readonly promptBlocks?: readonly ContentBlock[];
  readonly systemPrompt: string;
  readonly workingDirectory: string;
  readonly cc: CCBackendConfig;
  readonly serverUrl: string;
  readonly userMemoryDbPath: string;
  readonly model?: string;
  readonly clientMcpServers?: readonly McpServer[];
  readonly bootServer?: McpSdkServerConfigWithInstance;
  readonly permissionMode?: PermissionMode;
  readonly effort?: EffortLevel;
  readonly rules?: readonly RuleEntry[];
  readonly signal?: AbortSignal;
};

/**
 * Boot instruction appended to the system prompt. Tells the model to call
 * the three boot tools at the START of the session (first turn only) to
 * load per-session context. The streaming-input Query stays alive across
 * turns, so the conversation context is naturally preserved without any
 * disk-backed transcript or `--continue` replay.
 */
const BOOT_INSTRUCTION = `At the start of this session, BEFORE responding to anything else, call all three boot tools in parallel to load your context:

1. \`load_user_profile\` — developer identity, preferences, and memories
2. \`load_project_rules\` — this project's rules and conventions (CLAUDE.md, .claude/rules/)
3. \`load_session_context\` — summaries, memories, and narrated history for this conversation

Call all three in parallel. Do not skip any. Do not respond to the user until you have loaded and read all three results.

Then begin working with the user normally. You do not need to call these tools again on subsequent turns — your session context is preserved automatically.`;

/** Build the SDK Options object from runner options. */
export const buildSdkOptions = (
  options: Pick<
    RunClaudeCodeOptions,
    | "systemPrompt"
    | "model"
    | "cc"
    | "workingDirectory"
    | "serverUrl"
    | "userMemoryDbPath"
    | "clientMcpServers"
    | "bootServer"
    | "permissionMode"
    | "effort"
    | "rules"
  >,
) => {
  const systemPrompt = `${options.systemPrompt}\n\n${BOOT_INSTRUCTION}`;

  const startupMode = isValidCCMode(options.cc.permissionMode)
    ? options.cc.permissionMode
    : undefined;
  const permissionMode = options.permissionMode ?? startupMode;

  const sdkOptions: Options = {
    cwd: options.workingDirectory,
    systemPrompt,
    permissionMode,
    ...(permissionMode === "bypassPermissions"
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    mcpServers: buildMcpServers(
      options.serverUrl,
      options.userMemoryDbPath,
      options.clientMcpServers,
      options.bootServer,
    ),
    strictMcpConfig: true,
    // No persistSession / continue: continuity comes from the long-lived
    // streaming-input Query (one subprocess per session, fed via
    // streamInput). Disk-backed JSONL replay is exactly the cost we're
    // avoiding — every turn was re-sending the full transcript over the
    // wire (~6.9M prompt tokens/turn average). The mimir-server is the
    // source of truth for cross-session recovery; one session per process.
    // Hard-disable filesystem settings discovery. Without `[]` the CLI
    // would load ~/.claude/settings.json, .claude/settings.json, and
    // .claude/settings.local.json — bringing in user-level rule rules,
    // plugin configs, and skill listings that bloat every prompt.
    settingSources: [],
    // Per the SDK type docs, omitting `skills` lets the CLI's defaults
    // apply, which is NOT "skills off." `[]` is the only way to turn
    // every discovered plugin skill out of the system prompt every turn.
    skills: [],
    // Same story for plugins.
    plugins: [],
    includePartialMessages: true,
    // Thinking config is per-model. Adaptive is the modern default; older
    // models that don't advertise it fall back to enabled with a fixed
    // budget. supportsAdaptiveThinking reads a capability cache populated
    // at model-discovery time.
    thinking:
      supportsAdaptiveThinking(options.model) === false
        ? {
            type: "enabled",
            display: "summarized",
            budgetTokens: 31999,
          }
        : { type: "adaptive", display: "summarized" },
    env: {
      ...process.env,
      ENABLE_TOOL_SEARCH: "false",
      // mimir owns project rules via the load_project_rules boot tool.
      // CC's auto-memory injection (~/.claude/projects/<encoded>/memory/
      // MEMORY.md) would duplicate that context every turn outside our
      // caching discipline; this env var is the targeted kill switch and
      // leaves explicit user/project CLAUDE.md alone (governed by
      // settingSources: []).
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    },
  };

  if (options.cc.disallowedTools.length > 0) {
    sdkOptions.disallowedTools = [...options.cc.disallowedTools];
  }
  if (options.model) {
    sdkOptions.model = options.model;
  }
  if (options.effort) {
    sdkOptions.effort = options.effort;
  }
  if (typeof options.cc.maxTurns === "number") {
    sdkOptions.maxTurns = options.cc.maxTurns;
  }
  if (typeof options.cc.maxBudgetUsd === "number") {
    sdkOptions.maxBudgetUsd = options.cc.maxBudgetUsd;
  }
  if (options.rules && options.rules.length > 0) {
    sdkOptions.hooks = {
      PreToolUse: buildRuleHook(options.rules),
    };
  }

  return sdkOptions;
};
