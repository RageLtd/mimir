import type { ModelMessage, StepResult, ToolSet, TypedToolCall } from "ai";

import { extractAndStoreMemories } from "../goldfish/memory";
import { log } from "../util/logger";
import { runCompaction } from "./compaction";
import { updateTokenCount } from "./message-log/index";
import { SERVER_TOOL_NAMES } from "./server-tools";

/**
 * Post-processing shared between streaming and non-streaming agent runs.
 *
 * After the LLM response completes (whether via generateText or streamText),
 * three things need to happen:
 * 1. Persist server-side tool calls/results to the message log
 * 2. Update token count and trigger compaction if needed (fire-and-forget)
 * 3. Extract and store memories from the conversation (fire-and-forget)
 *
 * Extracted here so runAgent and the streaming handler don't duplicate
 * the same logic.
 */

// ---------------------------------------------------------------------------
// Step persistence
// ---------------------------------------------------------------------------

/**
 * Persist server-side tool calls and results from each agent step.
 *
 * NOTE: Server tool steps are NOT persisted to the message log.
 * They are ephemeral — executed within the agent loop, their results
 * feed into the next model turn, and only the final assistant response
 * matters for conversation history. Persisting them would break the
 * count-based dedup in appendNewMessages (two writers to the same DB).
 *
 * This function is kept as a no-op stub for future use if we switch
 * to content-hash-based dedup.
 */
export async function persistServerToolSteps<TOOLS extends ToolSet>(
  _steps: Array<StepResult<TOOLS>>,
  _project: string,
): Promise<void> {
  // Intentionally empty — see comment above
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
