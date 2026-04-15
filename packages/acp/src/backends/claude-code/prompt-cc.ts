/**
 * Claude Code backend prompt path.
 *
 * Fetches assembled context from mimir-server (system prompt, summaries,
 * memories, historical turns). Converts the system prompt to Anthropic XML,
 * injects local user context, formats prior turns as structured text in the
 * system prompt, and passes the current user message as the SDK prompt input.
 * mimir-server owns all context; CC is stateless.
 */

import type * as acp from "@agentclientprotocol/sdk";
import {
  buildToolCallContent,
  extractLocations,
  toolKindFor,
  toolTitle,
} from "../../agent/tool-reporting";
import type { SessionState } from "../../agent/types";
import {
  type AssembledMessage,
  assembleContext,
  type ContextClientConfig,
  persistTurn,
  reportTokenUsage,
} from "../../context-client";
import type { UserMemoryStore } from "../../store/user-memories";
import { buildUserContext } from "../../tools/user-memory";
import { errMessage } from "../../util";
import { createChildLogger, log } from "../../utils/log";
import { toAnthropicXml } from "../../utils/markdown-to-xml";
import type { Backend, BackendEvent } from "../types";

const logger = createChildLogger(log, "prompt-cc");

/** Maps tool call IDs to tool names + args so tool_result events can build rich content. */
const ccToolCallInfo = new Map<
  string,
  { name: string; input: Record<string, unknown> }
>();

const handleCCEvent = async (
  event: BackendEvent,
  session: SessionState,
  conn: acp.AgentSideConnection,
  onText: (delta: string) => void,
): Promise<void> => {
  if (event.type === "text") {
    onText(event.text);
    await conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: event.text },
      },
    });
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
    ccToolCallInfo.set(event.id, {
      name: event.name,
      input: event.input,
    });
    const kind = toolKindFor(event.name);
    const locations = extractLocations(event.name, event.input);
    const title = toolTitle(event.name, event.input);
    const isBash =
      event.name === "Bash" ||
      event.name === "create_terminal" ||
      event.name === "terminal";

    await conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        _meta: {
          claudeCode: { toolName: event.name },
          ...(isBash && session.supportsTerminalOutput
            ? { terminal_info: { terminal_id: event.id } }
            : {}),
        },
        sessionUpdate: "tool_call",
        toolCallId: event.id,
        title,
        rawInput: event.input,
        kind,
        status: "pending" as const,
        content:
          isBash && session.supportsTerminalOutput
            ? [{ type: "terminal" as const, terminalId: event.id }]
            : [],
        ...(locations ? { locations } : {}),
      },
    });
    return;
  }

  if (event.type === "tool_result") {
    const info = ccToolCallInfo.get(event.id);
    const toolName = info?.name ?? event.id;
    const updateTitle = info ? toolTitle(info.name, info.input) : toolName;
    const isBash =
      toolName === "Bash" ||
      toolName === "create_terminal" ||
      toolName === "terminal";

    if (isBash && session.supportsTerminalOutput) {
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
    } else {
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
    }
    return;
  }

  if (event.type === "error") {
    logger.error("CC error:", event.error);
    await conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `Error: ${event.error}` },
      },
    });
  }
};

/**
 * Strip the trailing user message from the assembled array when it
 * matches the current query — that message goes as the SDK prompt input,
 * not as context. Everything else (summaries, memories, prior turns)
 * becomes structured context in the system prompt.
 */
export const contextWithoutCurrentTurn = (
  messages: readonly AssembledMessage[],
  currentQuery: string,
) => {
  const last = messages[messages.length - 1];
  if (last?.role === "user" && last.content === currentQuery) {
    return messages.slice(0, -1);
  }
  return messages;
};

export const promptViaClaudeCode = async (
  session: SessionState,
  promptText: string,
  conn: acp.AgentSideConnection,
  abortController: AbortController,
  backend: Backend,
  contextClient: ContextClientConfig,
  memoryStore: UserMemoryStore,
  promptBlocks?: readonly acp.ContentBlock[],
): Promise<acp.PromptResponse> => {
  // Single call to mimir-server assembles the full context: system prompt,
  // Goldfish memories, summaries, historical turns from DB, and the current
  // user message as the final entry.
  let context: Awaited<ReturnType<typeof assembleContext>>;
  try {
    context = await assembleContext(
      contextClient,
      promptText,
      session.projectPath,
      abortController.signal,
    );
  } catch (err) {
    const msg = errMessage(err);
    logger.error("assembleContext failed:", msg);
    await conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `Context assembly failed: ${msg}` },
      },
    });
    return { stopReason: "end_turn" };
  }

  // Convert system prompt from markdown to Anthropic XML.
  // Append local user context (profile + memories) so the model knows
  // about the user from the first turn. This data never leaves the client.
  const userContext = buildUserContext(memoryStore);
  const xmlSystemPrompt = userContext
    ? `${toAnthropicXml(context.systemPrompt)}\n\n${userContext}`
    : toAnthropicXml(context.systemPrompt);

  // The server's assembled messages include the context injection pair
  // (summaries + memories), historical turns, and the current user message.
  // Strip the current user message — it goes as the SDK prompt input.
  // Everything else becomes structured context in the system prompt.
  const contextMessages = contextWithoutCurrentTurn(
    context.messages,
    promptText,
  );

  logger.info(
    {
      serverMessageCount: context.messages.length,
      contextMessageCount: contextMessages.length,
      roles: contextMessages.map((m) => m.role),
    },
    "context assembled for CC backend",
  );

  // Track the user message for persistence.
  session.messages.push({ role: "user", content: promptText });

  let assistantBuffer = "";
  let promptTokens: number | undefined;
  let totalCostUsd: number | undefined;

  try {
    for await (const event of backend.run({
      prompt: promptText,
      promptBlocks,
      systemPrompt: xmlSystemPrompt,
      assembledMessages: contextMessages,
      messages: session.messages,
      tools: [],
      projectPath: session.projectPath,
      clientMcpServers: session.clientMcpServers,
      metadata: {},
      modelId: session.currentModelId,
      signal: abortController.signal,
    })) {
      await handleCCEvent(event, session, conn, (delta) => {
        assistantBuffer += delta;
      });

      if (event.type === "finish") {
        promptTokens = event.promptTokens;
        totalCostUsd = event.cost;
        if (typeof promptTokens === "number" && promptTokens > 0) {
          await conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "usage_update",
              used: promptTokens,
              size: 200_000,
              ...(typeof totalCostUsd === "number"
                ? { cost: { amount: totalCostUsd, currency: "USD" } }
                : {}),
            },
          });
        }
      } else if (event.type === "error") {
        return { stopReason: "end_turn" };
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      return { stopReason: "cancelled" };
    }
    const msg = errMessage(err);
    logger.error("CC backend error:", msg);
    return { stopReason: "end_turn" };
  }

  if (assistantBuffer.length > 0) {
    session.messages.push({ role: "assistant", content: assistantBuffer });
  }

  // Post-processing: persist + token report. Fire-and-forget.
  const projectForServer = session.projectPath || "default";
  persistTurn(contextClient, session.messages.slice(-2), projectForServer, {
    totalCostUsd,
  }).catch((err) => logger.warn("persistTurn failed:", err));

  if (typeof promptTokens === "number" && promptTokens > 0) {
    reportTokenUsage(
      contextClient,
      promptTokens,
      projectForServer,
      session.currentModelId,
    ).catch((err) => logger.warn("reportTokenUsage failed:", err));
  }

  return { stopReason: "end_turn" };
};
