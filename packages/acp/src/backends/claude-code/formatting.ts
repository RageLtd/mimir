/**
 * Context formatting and SDK option building for the Claude Code backend.
 *
 * `formatContextForPrompt` converts assembled context messages to the
 * structured text appended to the system prompt. `buildSdkOptions`
 * assembles the SDK options object. Both are pure functions with no
 * side effects, making them straightforward to unit test.
 */

import type { ContentBlock, McpServer } from "@agentclientprotocol/sdk";
import type {
  EffortLevel,
  McpSdkServerConfigWithInstance,
  Options,
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import type { CCBackendConfig } from "../../config";
import { buildMcpServers } from "./mcp-config";
import { supportsAdaptiveThinking } from "./model-capabilities";
import { buildRuleHook, type Detector } from "./rule-hooks";

/**
 * Format assembled context messages (summaries, memories, prior turns)
 * as structured text appended to the system prompt. The current user
 * message must NOT be included — it goes as the SDK prompt input.
 */
export const formatContextForPrompt = (
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
): string => {
  if (messages.length === 0) return "";
  const lines = messages.map(
    (m) => `[${m.role === "user" ? "User" : "Assistant"}]\n${m.content}`,
  );
  return `<conversation_context>\n${lines.join("\n\n")}\n</conversation_context>`;
};

export type RunClaudeCodeOptions = {
  /** Current user prompt text — used as prompt fallback when promptBlocks is absent. */
  readonly prompt: string;
  /**
   * Raw ACP content blocks for the current turn. When present, converted to
   * Anthropic content format for the SDK prompt input. Preserves image data
   * that would be lost if the prompt were flattened to plain text.
   */
  readonly promptBlocks?: readonly ContentBlock[];
  readonly systemPrompt: string;
  readonly workingDirectory: string;
  readonly cc: CCBackendConfig;
  /** The mimir-server URL, needed to build the MCP config. */
  readonly serverUrl: string;
  /** Path to the user memory SQLite database. */
  readonly userMemoryDbPath: string;
  /** SDK model value; e.g. "opus", "sonnet". */
  readonly model?: string;
  /** MCP servers from the ACP client to merge into the SDK MCP config. */
  readonly clientMcpServers?: readonly McpServer[];
  /** In-process boot MCP server delivering per-session context as tool results. */
  readonly bootServer?: McpSdkServerConfigWithInstance;
  /**
   * Permission mode for this turn. Overrides `cc.permissionMode` from the
   * startup config when provided — set by the session's mode selector.
   */
  readonly permissionMode?: PermissionMode;
  /**
   * Effort level for this turn. Set by the session's thought-level selector
   * (CC backend only). Omitted for models that don't advertise effort support.
   */
  readonly effort?: EffortLevel;
  /**
   * Rule-detect sidecars loaded from `.claude/rules/**\/*.detect.ts` in the
   * project. When non-empty, they're wired into a PreToolUse hook that runs
   * on every Edit/Write/MultiEdit and injects violation notices as
   * `additionalContext`. Loaded once per session at newSession time.
   */
  readonly ruleDetectors?: readonly Detector[];
  readonly signal?: AbortSignal;
};

/**
 * Boot instruction appended to the system prompt. Tells the model to
 * call the two boot tools on its first turn to load per-session context.
 * Session context (summaries, memories, prior turns) is injected directly
 * into the system prompt rather than via a boot tool.
 */
const BOOT_INSTRUCTION = `<boot_sequence>
At the start of every session, BEFORE responding to the user's message, call these two tools in parallel to load your context:

1. \`load_user_profile\` — developer identity, preferences, and memories
2. \`load_project_rules\` — this project's rules and conventions (CLAUDE.md, .claude/rules/)

Call both in your first response. Do not skip either. Do not respond to the user until you have loaded and read both results. The tool results, combined with the session context already in this prompt, contain your operating context for this session.
</boot_sequence>`;

/** Build the SDK Options object from runner options. Pure function, easy to test. */
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
    | "ruleDetectors"
  >,
) => {
  // System prompt arrives with session context already embedded (injected by
  // prompt-cc.ts). Boot instruction appended after it.
  const fullSystemPrompt = `${options.systemPrompt}\n\n${BOOT_INSTRUCTION}`;

  // Turn-level permission mode overrides the startup default. This lets the
  // session's mode selector take effect without restarting the ACP.
  const permissionMode =
    options.permissionMode ??
    (options.cc.permissionMode as PermissionMode);

  const sdkOptions: Options = {
    cwd: options.workingDirectory,
    systemPrompt: fullSystemPrompt,
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
    persistSession: true,
    continue: true,
    settingSources: [],
    includePartialMessages: true,
    // Thinking mode shaped per-model from the capability cache populated at
    // startup by discoverCCModelsViaSdk. Undefined (unknown/discovery-failed)
    // defaults to adaptive — the forward-looking pick for the current
    // Anthropic catalogue, where adaptive-capable models dominate. Known
    // legacy models fall back to enabled mode with an explicit budget.
    thinking:
      supportsAdaptiveThinking(options.model) === false
        ? {
            type: "enabled",
            display: "summarized",
            budgetTokens: 31999,
          }
        : { type: "adaptive", display: "summarized" },
    env: { ...process.env, ENABLE_TOOL_SEARCH: "false" },
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

  // Rule-detect hooks — advisory nudges on known anti-patterns. Only
  // attached when the project ships `.detect.ts` sidecars.
  if (options.ruleDetectors && options.ruleDetectors.length > 0) {
    sdkOptions.hooks = {
      PreToolUse: buildRuleHook(options.ruleDetectors),
    };
  }

  return sdkOptions;
};
