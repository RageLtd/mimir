/**
 * Claude Code backend event translator.
 *
 * Converts the normalised `BackendEvent` stream from `runClaudeCode` into
 * ACP `session/update` notifications. Pure adapter — no orchestration,
 * no SDK calls, no async state outside what the caller hands in. Each
 * event becomes zero or more `conn.sessionUpdate` calls.
 *
 * Special cases:
 * - `Bash` / `create_terminal` / `terminal` tool calls render as terminal
 *   widgets when the client advertises `_meta.terminal_output`.
 * - `TodoWrite` tool calls also emit a `plan` update for the agent panel.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { emitAgentText } from "../../agent/lifecycle-helpers";
import {
  buildToolCallContent,
  extractLocations,
  toolKindFor,
  toolTitle,
} from "../../agent/tool-reporting";
import type { SessionState } from "../../agent/types";
import { createChildLogger, log } from "../../utils/log";
import type { BackendEvent } from "../types";

const logger = createChildLogger(log, "cc-event-handler");

/**
 * Per-invocation registry mapping tool-call IDs to the original tool name +
 * input record. `tool_result` events only carry the id, so we look up the
 * paired call here to render rich update content. Lives in the caller's
 * closure (one per `promptViaClaudeCode` invocation) — never module-level.
 */
export type CcToolCallInfo = Map<
  string,
  { name: string; input: Record<string, unknown> }
>;

const TERMINAL_TOOLS = new Set(["Bash", "create_terminal", "terminal"]);

const isTerminalTool = (name: string) => TERMINAL_TOOLS.has(name);

const supportsTerminalOutput = (session: SessionState) =>
  session.clientCapabilities._meta?.terminal_output === true;

/** Translate TodoWrite input into an ACP `plan` session update. */
const emitPlanUpdate = async (
  session: SessionState,
  conn: acp.AgentSideConnection,
  todos: readonly { content: string; status: string; activeForm?: string }[],
) => {
  await conn.sessionUpdate({
    sessionId: session.sessionId,
    update: {
      sessionUpdate: "plan",
      entries: todos.map((t) => ({
        content:
          t.activeForm && t.status === "in_progress" ? t.activeForm : t.content,
        status: t.status as "pending" | "in_progress" | "completed",
        priority: "medium" as const,
      })),
    },
  });
};

const handleToolCall = async (
  event: Extract<BackendEvent, { type: "tool_call" }>,
  session: SessionState,
  conn: acp.AgentSideConnection,
  toolCallInfo: CcToolCallInfo,
) => {
  toolCallInfo.set(event.id, { name: event.name, input: event.input });

  // TodoWrite → emit an ACP plan update alongside the normal tool card.
  if (event.name === "TodoWrite" && Array.isArray(event.input.todos)) {
    await emitPlanUpdate(
      session,
      conn,
      event.input.todos as {
        content: string;
        status: string;
        activeForm?: string;
      }[],
    );
  }

  const isBash = isTerminalTool(event.name);
  const showTerminal = isBash && supportsTerminalOutput(session);
  const locations = extractLocations(event.name, event.input);

  await conn.sessionUpdate({
    sessionId: session.sessionId,
    update: {
      _meta: {
        claudeCode: { toolName: event.name },
        ...(showTerminal ? { terminal_info: { terminal_id: event.id } } : {}),
      },
      sessionUpdate: "tool_call",
      toolCallId: event.id,
      title: toolTitle(event.name, event.input),
      rawInput: event.input,
      kind: toolKindFor(event.name),
      status: "pending" as const,
      content: showTerminal
        ? [{ type: "terminal" as const, terminalId: event.id }]
        : [],
      ...(locations ? { locations } : {}),
    },
  });
};

const handleToolResult = async (
  event: Extract<BackendEvent, { type: "tool_result" }>,
  session: SessionState,
  conn: acp.AgentSideConnection,
  toolCallInfo: CcToolCallInfo,
) => {
  const info = toolCallInfo.get(event.id);
  const toolName = info?.name ?? event.id;
  const updateTitle = info ? toolTitle(info.name, info.input) : toolName;
  const showTerminal =
    isTerminalTool(toolName) && supportsTerminalOutput(session);

  if (showTerminal) {
    // Stream output bytes first, then mark the terminal as exited so the
    // editor can render the captured run.
    await conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        _meta: {
          terminal_output: { terminal_id: event.id, data: event.output },
        },
        sessionUpdate: "tool_call_update",
        toolCallId: event.id,
      },
    });
    await conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        _meta: {
          claudeCode: { toolName },
          terminal_exit: {
            terminal_id: event.id,
            exit_code: 0,
            signal: null,
          },
        },
        sessionUpdate: "tool_call_update",
        toolCallId: event.id,
        title: updateTitle,
        rawOutput: event.output,
        status: "completed" as const,
        content: [{ type: "terminal" as const, terminalId: event.id }],
      },
    });
    return;
  }

  const content = info
    ? buildToolCallContent(toolName, info.input, event.output)
    : undefined;
  await conn.sessionUpdate({
    sessionId: session.sessionId,
    update: {
      _meta: { claudeCode: { toolName } },
      sessionUpdate: "tool_call_update",
      toolCallId: event.id,
      title: updateTitle,
      rawOutput: event.output,
      status: "completed" as const,
      ...(content ? { content } : {}),
    },
  });
};

export type HandleCCEventOptions = {
  readonly event: BackendEvent;
  readonly session: SessionState;
  readonly conn: acp.AgentSideConnection;
  readonly toolCallInfo: CcToolCallInfo;
  readonly onText: (delta: string) => void;
};

export const handleCCEvent = async ({
  event,
  session,
  conn,
  toolCallInfo,
  onText,
}: HandleCCEventOptions) => {
  if (event.type === "text") {
    onText(event.text);
    await emitAgentText(conn, session.sessionId, event.text);
    return;
  }

  if (event.type === "thinking") {
    await conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: event.text },
      },
    });
    return;
  }

  if (event.type === "tool_call") {
    await handleToolCall(event, session, conn, toolCallInfo);
    return;
  }

  if (event.type === "tool_result") {
    await handleToolResult(event, session, conn, toolCallInfo);
    return;
  }

  if (event.type === "error") {
    logger.error("CC error:", event.error);
    await emitAgentText(conn, session.sessionId, `Error: ${event.error}`);
  }
};
