/**
 * Codex backend prompt path.
 *
 * Codex owns the local agent/tool loop. Mimir assembles first-turn context
 * into a replacement instruction file, streams observed SDK events to ACP,
 * and persists local assistant turns back to mimir-server.
 */

import { mkdir } from "node:fs/promises";
import type * as acp from "@agentclientprotocol/sdk";
import { emitAgentText, emitPlanUpdate } from "../../agent/lifecycle-helpers";
import {
  buildToolCallContent,
  toolKindFor,
  toolTitle,
} from "../../agent/tool-reporting";
import type { SessionState } from "../../agent/types";
import { isFileWriteTool } from "../../cartographer/lifecycle";
import {
  assembleContext,
  type ContextClientConfig,
  getSystemPrompt,
  persistTurn,
  reportTokenUsage,
} from "../../context-client";
import type { UserMemoryStore } from "../../store/user-memories";
import { buildUserContext } from "../../tools/user-memory";
import { errMessage } from "../../util";
import { createChildLogger, log } from "../../utils/log";
import { formatContextForPrompt } from "../claude-code/formatting";
import type { Backend, BackendEvent } from "../types";
import {
  type CodexBootContent,
  formatCodexInstructions,
} from "./boot-formatting";
import { startCodexPermissionBridge } from "./permission-bridge";

const logger = createChildLogger(log, "prompt-codex");

const instructionDir = () => "/tmp/mimir-codex-instructions";

const writeInstructionFile = async (sessionId: string, content: string) => {
  const dir = instructionDir();
  await mkdir(dir, { recursive: true });
  const path = `${dir}/${sessionId}.md`;
  await Bun.write(path, content);
  return path;
};

type CodexToolCallInfo = Map<
  string,
  { name: string; input: Record<string, unknown> }
>;

const supportsTerminalOutput = (session: SessionState) =>
  session.clientCapabilities._meta?.terminal_output === true;

const isTerminalTool = (name: string) => name === "terminal";

const todoUpdatesFromInput = (input: Record<string, unknown>) => {
  if (!Array.isArray(input.todos)) return [];
  return input.todos.flatMap((todo) => {
    if (!todo || typeof todo !== "object") return [];
    if (!("content" in todo) || typeof todo.content !== "string") return [];
    const status =
      "status" in todo && typeof todo.status === "string"
        ? todo.status
        : "pending";
    const activeForm =
      "activeForm" in todo && typeof todo.activeForm === "string"
        ? todo.activeForm
        : undefined;
    return [
      {
        content: todo.content,
        status,
        ...(activeForm ? { activeForm } : {}),
      },
    ];
  });
};

const handleToolCall = async (
  event: Extract<BackendEvent, { type: "tool_call" }>,
  session: SessionState,
  conn: acp.AgentSideConnection,
  toolCallInfo: CodexToolCallInfo,
) => {
  toolCallInfo.set(event.id, { name: event.name, input: event.input });

  const todos = todoUpdatesFromInput(event.input);
  if (event.name === "TodoWrite" && todos.length > 0) {
    await emitPlanUpdate(conn, session.sessionId, todos);
  }

  const showTerminal =
    isTerminalTool(event.name) && supportsTerminalOutput(session);
  const content = showTerminal
    ? [{ type: "terminal" as const, terminalId: event.id }]
    : (buildToolCallContent(event.name, event.input, "") ?? []);

  await conn.sessionUpdate({
    sessionId: session.sessionId,
    update: {
      _meta: {
        codex: { toolName: event.name },
        ...(showTerminal ? { terminal_info: { terminal_id: event.id } } : {}),
      },
      sessionUpdate: "tool_call",
      toolCallId: event.id,
      title: toolTitle(event.name, event.input),
      rawInput: event.input,
      kind: toolKindFor(event.name),
      status: "pending" as const,
      content,
    },
  });
};

const handleToolResult = async (
  event: Extract<BackendEvent, { type: "tool_result" }>,
  session: SessionState,
  conn: acp.AgentSideConnection,
  toolCallInfo: CodexToolCallInfo,
) => {
  const info = toolCallInfo.get(event.id);
  const toolName = info?.name ?? event.id;
  const input = info?.input ?? {};
  const showTerminal =
    isTerminalTool(toolName) && supportsTerminalOutput(session);

  if (showTerminal) {
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
          codex: { toolName },
          terminal_exit: {
            terminal_id: event.id,
            exit_code: 0,
            signal: null,
          },
        },
        sessionUpdate: "tool_call_update",
        toolCallId: event.id,
        title: toolTitle(toolName, input),
        rawOutput: event.output,
        status: "completed" as const,
        content: [{ type: "terminal" as const, terminalId: event.id }],
      },
    });
    return;
  }

  const content = buildToolCallContent(toolName, input, event.output);
  await conn.sessionUpdate({
    sessionId: session.sessionId,
    update: {
      _meta: { codex: { toolName } },
      sessionUpdate: "tool_call_update",
      toolCallId: event.id,
      title: toolTitle(toolName, input),
      rawOutput: event.output,
      status: "completed" as const,
      ...(content ? { content } : {}),
    },
  });
};

const handleCodexEvent = async (
  event: BackendEvent,
  session: SessionState,
  conn: acp.AgentSideConnection,
  toolCallInfo: CodexToolCallInfo,
  onText: (delta: string) => void,
) => {
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
    logger.error("Codex error:", event.error);
  }
};

export type PromptViaCodexOptions = {
  readonly session: SessionState;
  readonly promptText: string;
  readonly conn: acp.AgentSideConnection;
  readonly abortController: AbortController;
  readonly backend: Backend;
  readonly contextClient: ContextClientConfig;
  readonly memoryStore: UserMemoryStore;
  readonly promptBlocks?: readonly acp.ContentBlock[];
};

export const promptViaCodex = async (opts: PromptViaCodexOptions) => {
  const {
    session,
    promptText,
    conn,
    abortController,
    backend,
    contextClient,
    memoryStore,
  } = opts;

  session.messages.push({ role: "user", content: promptText });

  if (!session.codexInstructionPath) {
    const context = await assembleContext(
      contextClient,
      promptText,
      session.projectId ?? session.projectPath,
      abortController.signal,
    ).catch(errMessage);
    if (typeof context === "string") {
      logger.error("assembleContext failed:", context);
      await emitAgentText(
        conn,
        session.sessionId,
        `Context assembly failed: ${context}`,
      );
      return { stopReason: "refusal" as const, filesModified: false };
    }

    const priorMessages = context.messages.slice(0, -1);
    const sessionContextText = formatContextForPrompt(priorMessages);
    const bootContent: CodexBootContent = {
      userContext: buildUserContext(memoryStore),
      projectRules: session.projectRules,
      sessionContext: sessionContextText.length > 0 ? sessionContextText : null,
    };
    const instructions = formatCodexInstructions(
      context.systemPrompt,
      bootContent,
    );
    session.codexInstructionPath = await writeInstructionFile(
      session.sessionId,
      instructions,
    );
    logger.info(
      {
        instructionPath: session.codexInstructionPath,
        instructionChars: instructions.length,
        systemPromptChars: context.systemPrompt.length,
      },
      "Codex replacement instruction file written",
    );
  } else {
    getSystemPrompt(contextClient, abortController.signal).catch((err) =>
      logger.warn("system prompt refresh failed:", err),
    );
  }

  if (!session.codexPermissionBridge) {
    session.codexPermissionBridge = await startCodexPermissionBridge(
      session,
      conn,
    );
    session.codexThread = null;
    session.codexThreadConfig = null;
  }

  let assistantBuffer = "";
  let promptTokens: number | undefined;
  let streamErrored: string | null = null;
  const toolCallInfo: CodexToolCallInfo = new Map();

  const iter = backend
    .run({
      prompt: promptText,
      systemPrompt: "",
      messages: session.messages,
      tools: [],
      projectPath: session.projectPath,
      clientMcpServers: session.clientMcpServers,
      metadata: {},
      modelId: session.currentModelId,
      effort: session.currentThoughtLevel,
      signal: abortController.signal,
      session,
    })
    [Symbol.asyncIterator]();

  while (true) {
    const step = await iter.next().catch(errMessage);
    if (typeof step === "string") {
      if (abortController.signal.aborted) {
        return { stopReason: "cancelled" as const, filesModified: false };
      }
      logger.error("Codex backend error:", step);
      await emitAgentText(conn, session.sessionId, `Error: ${step}`);
      return { stopReason: "refusal" as const, filesModified: false };
    }
    if (step.done) break;
    const event = step.value;

    await handleCodexEvent(event, session, conn, toolCallInfo, (delta) => {
      assistantBuffer += delta;
    });

    if (event.type === "finish") {
      promptTokens = event.promptTokens;
      if (abortController.signal.aborted) {
        return {
          stopReason: "cancelled" as const,
          filesModified: false,
        };
      }
      if (event.stopReason && event.stopReason !== "success") {
        const detail = event.errors?.join("; ") ?? event.stopReason;
        await emitAgentText(conn, session.sessionId, `Error: ${detail}`);
        return { stopReason: "refusal" as const, filesModified: false };
      }
      if (streamErrored) {
        await emitAgentText(conn, session.sessionId, `Error: ${streamErrored}`);
        return { stopReason: "refusal" as const, filesModified: false };
      }
    } else if (event.type === "error") {
      streamErrored = event.error;
    }
  }

  if (assistantBuffer.length > 0) {
    session.messages.push({ role: "assistant", content: assistantBuffer });
  }
  session.bootSequenceDone = true;

  const projectForServer =
    session.projectId ?? session.projectPath ?? "default";
  persistTurn(
    contextClient,
    session.messages.slice(-2),
    projectForServer,
  ).catch((err) => logger.warn("persistTurn failed:", err));
  if (typeof promptTokens === "number" && promptTokens > 0) {
    reportTokenUsage(
      contextClient,
      promptTokens,
      projectForServer,
      session.currentModelId,
    ).catch((err) => logger.warn("reportTokenUsage failed:", err));
  }

  const filesModified = [...toolCallInfo.values()].some(
    (tool) => tool.name === "codex_file_change" || isFileWriteTool(tool.name),
  );
  return { stopReason: "end_turn" as const, filesModified };
};
