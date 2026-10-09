/**
 * The command-hook-shaped stdin the binary's tool subcommands read.
 *
 * `rules`, `guard`, `file-context`, `reindex` and `verify` were written
 * against the PreToolUse / PostToolUse payload and still parse it; the
 * module rebuilds that shape from a `tool.call` event, whose `e` is the
 * tool's arguments spread beside `tool`, `tool_use_id` and `agentId`.
 */

import type { ToolCallInput } from "claude-code";

/** What a tool.call hook knows about the loop it runs in. */
export type Loop = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly agentId?: string;
  readonly agentType?: string;
};

/** The tool's own arguments: `e` less the engine's reserved keys. */
export const toolInputOf = (e: ToolCallInput) => {
  const { tool: _tool, tool_use_id: _id, agentId: _agent, ...input } = e;
  return input;
};

export const toolPayload = (
  e: ToolCallInput,
  loop: Loop,
  hookEventName: "PreToolUse" | "PostToolUse" = "PreToolUse",
) => ({
  session_id: loop.sessionId,
  hook_event_name: hookEventName,
  cwd: loop.cwd,
  tool_name: e.tool,
  tool_input: toolInputOf(e),
  ...(loop.agentId === undefined ? {} : { agent_id: loop.agentId }),
  ...(loop.agentType === undefined ? {} : { agent_type: loop.agentType }),
});

/** The PreToolUse answer the tool subcommands print. */
export type PreToolUseOutput = {
  readonly hookSpecificOutput?: {
    readonly permissionDecision?: "allow" | "deny";
    readonly permissionDecisionReason?: string;
    readonly additionalContext?: string;
    readonly updatedInput?: Record<string, unknown>;
  };
  readonly systemMessage?: string;
};

/** The SubagentStop answer `mimir-cc verify` prints. */
export type SubagentStopOutput = {
  readonly decision?: "block";
  readonly reason?: string;
  readonly hookSpecificOutput?: { readonly additionalContext?: string };
};

export const parsePreToolUseOutput = (stdout: string) => {
  if (stdout.trim().length === 0) return {};
  // Serialisation boundary: the binary's stdout is JSON of a known shape.
  return JSON.parse(stdout) as PreToolUseOutput;
};

export const parseSubagentStopOutput = (stdout: string) => {
  if (stdout.trim().length === 0) return {};
  // Serialisation boundary: the binary's stdout is JSON of a known shape.
  return JSON.parse(stdout) as SubagentStopOutput;
};
