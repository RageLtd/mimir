import type {
  AssistantContent,
  ModelMessage,
  ToolSet,
  TypedToolCall,
} from "ai";

import { extractAndStoreMemories } from "../goldfish/memory";
import { log } from "../util/logger";
import { runCompaction } from "./compaction";
import { appendAssistantOutput, updateTokenCount } from "./message-log/index";
import { SERVER_TOOL_NAMES } from "./server-tools";

/**
 * Post-processing shared between streaming and non-streaming agent runs.
 *
 * After the LLM response completes, three things happen:
 *   1. Persist the final assistant output (persistAssistantTurn)
 *   2. Update token count and trigger compaction if needed (fire-and-forget)
 *   3. Extract and store memories from the conversation (fire-and-forget)
 *
 * Server-tool internal iterations are NOT persisted — they're ephemeral
 * by design. Only the final assistant output that crosses the server→client
 * boundary goes into the global log.
 */

// ---------------------------------------------------------------------------
// Tool call classification
// ---------------------------------------------------------------------------

/** Shared tool-call type used across both agent loop paths. */
export type ToolCall = { toolCallId: string; toolName: string; input: string };

/**
 * Split a set of tool calls into server-side (executed internally) and
 * client-side (emitted to the caller). Single source of truth for the
 * classification — both streaming and non-streaming loops use this.
 */
export function classifyToolCalls(toolCalls: ToolCall[]) {
  return {
    serverCalls: toolCalls.filter((tc) => SERVER_TOOL_NAMES.has(tc.toolName)),
    clientCalls: toolCalls.filter((tc) => !SERVER_TOOL_NAMES.has(tc.toolName)),
  };
}

// ---------------------------------------------------------------------------
// Post-turn finalization
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget post-processing trio at the end of an agent turn:
 * persist the assistant output, update compaction state, extract memories.
 *
 * Both streaming and non-streaming agent loops call this identically.
 * Consolidating here ensures the three steps stay in sync.
 */
export function finalizeTurn(
  text: string,
  toolCalls: ToolCall[],
  reasoning: string | undefined,
  ctx: { project: string | null | undefined; request: { messages: ModelMessage[]; model: string } },
  lastStepInputTokens: number,
) {
  persistAssistantTurn(text, toolCalls, ctx.project, reasoning).catch((err) =>
    log.error({ err }, "persistAssistantTurn failed"),
  );

  triggerCompactionIfNeeded(lastStepInputTokens, ctx.project ?? null, ctx.request.model);

  const lastUserMessage = [...ctx.request.messages]
    .reverse()
    .find((m) => m.role === "user");
  extractMemoriesFromResponse(text || null, lastUserMessage ?? null, ctx.project);
}

// ---------------------------------------------------------------------------
// Compaction
// ---------------------------------------------------------------------------

/**
 * Update token count and trigger async compaction if the threshold is reached.
 * Fire-and-forget — errors are logged but never propagated.
 *
 * Always calls updateTokenCount — even with zero tokens it keeps the
 * compaction state row alive.
 */
export function triggerCompactionIfNeeded(
  promptTokens: number,
  project: string | null,
  modelId?: string,
): void {
  updateTokenCount(promptTokens, modelId)
    .then(({ needsCompaction }) => {
      if (needsCompaction) {
        log.info(
          { project: project ?? "default" },
          "triggering async compaction",
        );
        runCompaction(modelId).catch((err) =>
          log.error({ err }, "compaction failed"),
        );
      }
    })
    .catch((err) => log.error({ err }, "failed to update token count"));
}

// ---------------------------------------------------------------------------
// Final assistant output persistence
// ---------------------------------------------------------------------------

/**
 * Persist the final assistant output at the end of an LLM turn.
 *
 * Server-owned single-brain write: the server writes its own emissions
 * (assistant text plus any client-destined tool_call parts) to the global
 * log. Client requests only contribute trailing user/tool messages; the
 * assistant side of the conversation is always server-written.
 *
 * Fire-and-forget at call sites — persistence failure must not fail the
 * response. Errors are logged. Returns immediately when there's no text
 * and no tool calls (e.g., cancellation before any emission).
 */
export async function persistAssistantTurn(
  text: string,
  toolCalls: Array<{ toolCallId: string; toolName: string; input: string }>,
  project: string | null | undefined,
  reasoning?: string,
) {
  const clientToolCalls = toolCalls.filter(
    (tc) => !SERVER_TOOL_NAMES.has(tc.toolName),
  );
  const hasText = text.trim().length > 0;
  const hasToolCalls = clientToolCalls.length > 0;
  const hasReasoning = reasoning && reasoning.trim().length > 0;
  if (!hasText && !hasToolCalls && !hasReasoning) return;

  // Tool-call inputs are kept as raw JSON strings here — DB storage uses
  // JSON.stringify on content regardless, and clients reconstructing
  // history via the read path get the same shape either way.
  const parts: AssistantContent = [];
  if (hasReasoning) parts.push({ type: "reasoning", text: reasoning });
  if (hasText) parts.push({ type: "text", text });
  for (const tc of clientToolCalls) {
    parts.push({
      type: "tool-call",
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      input: tc.input,
    });
  }

  const message: ModelMessage = {
    role: "assistant",
    content: parts,
  };
  await appendAssistantOutput(message, project ?? "default").catch((err) =>
    log.error({ err }, "failed to persist assistant turn"),
  );
}

// ---------------------------------------------------------------------------
// Memory extraction
// ---------------------------------------------------------------------------

/**
 * Extract and store memories from the conversation, fire-and-forget.
 * Only extracts when there's both text content and a prior user message.
 */
export function extractMemoriesFromResponse(
  assistantContent: string | null | undefined,
  lastUserMessage: ModelMessage | null,
  project: string | null | undefined,
): void {
  if (!assistantContent || !lastUserMessage) return;

  const messages: ModelMessage[] = [
    lastUserMessage,
    { role: "assistant", content: assistantContent },
  ];
  extractAndStoreMemories(messages, project ?? undefined).catch((err) =>
    log.error({ err }, "extraction error"),
  );
}

// ---------------------------------------------------------------------------
// Client tool call formatting
// ---------------------------------------------------------------------------

/**
 * Filter tool calls to client-only and format in OpenAI spec.
 * Server tool calls are excluded — they're persisted separately.
 *
 * Uses AI SDK's TypedToolCall for better type safety.
 */
export function formatClientToolCalls<TOOLS extends ToolSet>(
  toolCalls: Array<TypedToolCall<TOOLS>>,
): Array<{
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}> {
  return toolCalls
    .filter((tc) => !SERVER_TOOL_NAMES.has(tc.toolName))
    .map((tc) => ({
      id: tc.toolCallId,
      type: "function" as const,
      function: {
        name: tc.toolName,
        arguments: JSON.stringify(tc.input),
      },
    }));
}
