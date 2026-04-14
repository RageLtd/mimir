/**
 * Context formatting and CLI arg building for the Claude Code backend.
 *
 * `formatContextForPrompt` converts assembled context messages to the
 * structured text injected via --append-system-prompt. `buildArgs`
 * assembles the full `claude` CLI argument list. Both are pure functions
 * with no side effects, making them straightforward to unit test.
 */

import type { ContentBlock, McpServer } from "@agentclientprotocol/sdk";
import type { CCBackendConfig } from "../../config";

/**
 * Format assembled context messages (summaries, memories, prior turns)
 * as structured text for --append-system-prompt. The current user
 * message must NOT be included — it goes as NDJSON via stdin.
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
  /** Current user prompt text — used as stdin fallback when promptBlocks is absent. */
  readonly prompt: string;
  /**
   * Raw ACP content blocks for the current turn. When present, converted to
   * Anthropic content format and written to stdin as NDJSON. Preserves image
   * data that would be lost if the prompt were flattened to plain text.
   */
  readonly promptBlocks?: readonly ContentBlock[];
  /**
   * Prior context messages (summaries, memories, conversation history)
   * injected via --append-system-prompt. Must NOT include the current
   * user message — that goes via stdin as NDJSON.
   */
  readonly contextMessages: ReadonlyArray<{
    role: "user" | "assistant";
    content: string;
  }>;
  readonly systemPrompt: string;
  readonly workingDirectory: string;
  readonly cc: CCBackendConfig;
  /** The mimir-server URL, needed to build the MCP config's mimir entry. */
  readonly serverUrl: string;
  /** Path to the user memory SQLite database. */
  readonly userMemoryDbPath: string;
  /** CC --model flag value; e.g. "opus", "sonnet[1m]". */
  readonly model?: string;
  /** MCP servers from the ACP client to merge into the CC MCP config. */
  readonly clientMcpServers?: readonly McpServer[];
  readonly signal?: AbortSignal;
};

/** Build the CLI args array for `claude`. Pure function, easy to test. */
export const buildArgs = (
  options: Pick<
    RunClaudeCodeOptions,
    "contextMessages" | "systemPrompt" | "model" | "cc"
  >,
  mcpConfigPath: string,
): string[] => {
  const contextText = formatContextForPrompt(options.contextMessages);
  const args: string[] = [
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--mcp-config",
    mcpConfigPath,
    "--permission-mode",
    options.cc.permissionMode,
    "--system-prompt",
    options.systemPrompt,
  ];

  if (contextText) {
    args.push("--append-system-prompt", contextText);
  }
  if (options.cc.disallowedTools.length > 0) {
    args.push("--disallowedTools", options.cc.disallowedTools.join(","));
  }
  if (options.model) {
    args.push("--model", options.model);
  }

  return args;
};
