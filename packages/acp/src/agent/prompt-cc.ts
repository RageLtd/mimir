/**
 * Claude Code backend prompt path.
 *
 * Fetches context from mimir-server, assembles the wrapped prompt,
 * spawns CC, streams events to the editor (including thinking chunks),
 * and persists the conversation back to mimir-server on completion.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { Backend, BackendEvent } from "../backends/types";
import {
  type ContextClientConfig,
  fetchMemories,
  fetchSummaries,
  getSystemPrompt,
  persistTurn,
  reportTokenUsage,
} from "../context-client";
import type { UserMemoryStore } from "../store/user-memories";
import { createChildLogger, log } from "../utils/log";
import { toAnthropicXml } from "../utils/markdown-to-xml";
import { buildCCPrompt } from "./content";
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
    // Stream thinking to the editor as thought chunks
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

    // Observe-only: surface to the editor for visibility, don't execute.
    await conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: event.id,
        title,
        rawInput: event.input,
        kind,
        status: "in_progress" as const,
        ...(locations ? { locations } : {}),
      },
    });
    return;
  }

  if (event.type === "tool_result") {
    const info = ccToolCallInfo.get(event.id);
    const toolName = info?.name ?? event.id;
    const content = info
      ? buildToolCallContent(toolName, info.input, event.output)
      : undefined;

    await conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: event.id,
        title: toolName,
        rawOutput: { content: event.output },
        status: "completed" as const,
        ...(content ? { content } : {}),
      },
    });
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

export const promptViaClaudeCode = async (
  session: SessionState,
  promptText: string,
  conn: acp.AgentSideConnection,
  abortController: AbortController,
  backend: Backend,
  contextClient: ContextClientConfig,
  memoryStore: UserMemoryStore,
): Promise<acp.PromptResponse> => {
  const isResume = !!session.ccSessionId;

  // Fetch context from mimir-server. System prompt is always needed; on
  // --resume CC already has prior summaries/memories in its session, so
  // skip injecting them again.
  const [systemPromptRaw, memories, summaries] = await Promise.all([
    getSystemPrompt(contextClient, abortController.signal).catch((err) => {
      logger.warn("system prompt fetch failed:", err);
      return "";
    }),
    isResume
      ? Promise.resolve(null)
      : fetchMemories(
          contextClient,
          promptText,
          session.projectPath,
          abortController.signal,
        ).catch((err) => {
          logger.warn("memories fetch failed:", err);
          return null;
        }),
    isResume
      ? Promise.resolve([])
      : fetchSummaries(contextClient, 3, abortController.signal).catch(
          (err) => {
            logger.warn("summaries fetch failed:", err);
            return [];
          },
        ),
  ]);

  const systemPrompt = toAnthropicXml(systemPromptRaw);

  const userProfile = isResume ? null : memoryStore.getProfileAsText();
  const assembledPrompt = isResume
    ? promptText
    : buildCCPrompt(promptText, summaries, memories, userProfile);

  // Track the user message for persistence even though CC owns the rest
  session.messages.push({ role: "user", content: promptText });

  let assistantBuffer = "";
  let promptTokens: number | undefined;
  let totalCostUsd: number | undefined;

  try {
    for await (const event of backend.run({
      prompt: assembledPrompt,
      systemPrompt,
      messages: session.messages,
      tools: [],
      projectPath: session.projectPath,
      ccResumeSessionId: session.ccSessionId,
      metadata: {},
      modelId: session.currentModelId,
      signal: abortController.signal,
    })) {
      await handleCCEvent(event, session, conn, (delta) => {
        assistantBuffer += delta;
      });

      if (event.type === "init") {
        session.ccSessionId = event.sessionId;
      } else if (event.type === "finish") {
        promptTokens = event.promptTokens;
        totalCostUsd = event.cost;
        // Forward token usage + cost to the ACP client so the editor can
        // display context consumption and session cost in real time.
        if (typeof promptTokens === "number" && promptTokens > 0) {
          await conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "usage_update",
              used: promptTokens,
              // 200 000 is the standard context window across current Claude models.
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

  // Push the assistant turn we observed (text only — CC's tool exchanges
  // live inside its own session; we don't try to mirror them into the
  // OpenAI-shape message log).
  if (assistantBuffer.length > 0) {
    session.messages.push({ role: "assistant", content: assistantBuffer });
  }

  // Post-processing: persist + token report. Fire-and-forget; don't
  // block the response on these.
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
