/**
 * Context formatting and SDK option building for the Claude Code backend.
 *
 * `formatContextForPrompt` converts assembled context messages to the
 * structured text appended to the system prompt. `buildSdkOptions`
 * assembles the SDK options object. Both are pure functions with no
 * side effects, making them straightforward to unit test.
 */

import type { ContentBlock, McpServer } from "@agentclientprotocol/sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { CCBackendConfig } from "../../config";
import { buildMcpServers } from "./mcp-config";

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
  /**
   * Prior context messages (summaries, memories, conversation history)
   * appended to the system prompt. Must NOT include the current user
   * message — that goes as the SDK prompt input.
   */
  readonly contextMessages: ReadonlyArray<{
    role: "user" | "assistant";
    content: string;
  }>;
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
  readonly signal?: AbortSignal;
};

/** Build the SDK Options object from runner options. Pure function, easy to test. */
export const buildSdkOptions = (
  options: Pick<
    RunClaudeCodeOptions,
    | "contextMessages"
    | "systemPrompt"
    | "model"
    | "cc"
    | "workingDirectory"
    | "serverUrl"
    | "userMemoryDbPath"
    | "clientMcpServers"
  >,
): Options => {
  const contextText = formatContextForPrompt(options.contextMessages);
  const fullSystemPrompt = contextText
    ? `${options.systemPrompt}\n\n${contextText}`
    : options.systemPrompt;

  const sdkOptions: Options = {
    cwd: options.workingDirectory,
    systemPrompt: fullSystemPrompt,
    permissionMode: options.cc.permissionMode as Options["permissionMode"],
    ...(options.cc.permissionMode === "bypassPermissions"
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    mcpServers: buildMcpServers(
      options.serverUrl,
      options.userMemoryDbPath,
      options.clientMcpServers,
    ),
    strictMcpConfig: true,
    persistSession: false,
    settingSources: [],
    includePartialMessages: true,
    env: { ...process.env, ENABLE_TOOL_SEARCH: "false" },
  };

  if (options.cc.disallowedTools.length > 0) {
    sdkOptions.disallowedTools = [...options.cc.disallowedTools];
  }
  if (options.model) {
    sdkOptions.model = options.model;
  }

  return sdkOptions;
};
