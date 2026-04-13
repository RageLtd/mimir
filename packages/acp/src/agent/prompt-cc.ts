/**
 * Claude Code backend prompt path.
 *
 * Fetches fully assembled context from mimir-server in a single call, then
 * pipes it to CC as stream-json NDJSON via stdin. No session persistence —
 * mimir-server owns all context; CC is stateless inference.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { Backend, BackendEvent } from "../backends/types";
import {
  assembleContext,
  type AssembledMessage,
  type ContextClientConfig,
  persistTurn,
  reportTokenUsage,
} from "../context-client";
import { createChildLogger, log } from "../utils/log";
import { toAnthropicXml } from "../utils/markdown-to-xml";
import {
  buildToolCallContent,
  extractLocations,
  toolKindFor,
  toolTitle,
} from "./tool-reporting";
import type { SessionState } from "./types";

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
 * Separate the context injection pair from conversation history in the
 * assembled message array. The server bakes a synthetic
 * "Session context: ..." / "Understood." pair at the front when summaries
 * or memories exist. We pull that out so we can inject the context into
 * the user's latest message instead.
 */
const extractContextAndHistory = (
  messages: readonly AssembledMessage[],
  currentQuery: string,
) => {
  let contextBlock: string | null = null;
  const history: AssembledMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;

    // Detect context injection pair
    if (msg.role === "user" && msg.content.startsWith("Session context:\n")) {
      contextBlock = msg.content.slice("Session context:\n".length);
      // Skip the paired "Understood." assistant response
      const next = messages[i + 1];
      if (next?.role === "assistant" && next.content === "Understood.") {
        i++;
      }
      continue;
    }

    // Skip the trailing user message that duplicates the current query
    if (
      i === messages.length - 1 &&
      msg.role === "user" &&
      msg.content === currentQuery
    ) {
      continue;
    }

    history.push(msg);
  }

  return { contextBlock, history };
};

/**
 * Build the full prompt string for `-p`.
 *
 * Layout:
 *   <conversation_history> ... </conversation_history>   (if any)
 *   <retrieved_context> ... </retrieved_context>          (if any)
 *   <current prompt text>
 */
const buildEnhancedPrompt = (
  history: readonly AssembledMessage[],
  contextBlock: string | null,
  currentQuery: string,
) => {
  const parts: string[] = [];

  if (history.length > 0) {
    const turns = history
      .map((m) => `<turn role="${m.role}">\n${m.content}\n</turn>`)
      .join("\n");
    parts.push(`<conversation_history>\n${turns}\n</conversation_history>`);
  }

  if (contextBlock) {
    parts.push(`<retrieved_context>\n${contextBlock}\n</retrieved_context>`);
  }

  parts.push(currentQuery);
  return parts.join("\n\n");
};

export const promptViaClaudeCode = async (
  session: SessionState,
  promptText: string,
  conn: acp.AgentSideConnection,
  abortController: AbortController,
  backend: Backend,
  contextClient: ContextClientConfig,
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
    const msg = err instanceof Error ? err.message : String(err);
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

  // 1. Convert system prompt from markdown to Anthropic XML
  const xmlSystemPrompt = toAnthropicXml(context.systemPrompt);

  // 2. Separate context injection from history, then build an enhanced
  //    prompt that embeds context directly in the user's message.
  const { contextBlock, history } = extractContextAndHistory(
    context.messages,
    promptText,
  );
  const enhancedPrompt = buildEnhancedPrompt(history, contextBlock, promptText);

  // Track the user message for persistence.
  session.messages.push({ role: "user", content: promptText });

  let assistantBuffer = "";
  let promptTokens: number | undefined;
  let totalCostUsd: number | undefined;

  try {
    for await (const event of backend.run({
      prompt: enhancedPrompt,
      systemPrompt: xmlSystemPrompt,
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
    const msg = err instanceof Error ? err.message : String(err);
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
