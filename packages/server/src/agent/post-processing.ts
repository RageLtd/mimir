import type { AssistantContent, ModelMessage, ToolSet } from "ai";

import { rootScope } from "../db/scope";
import { getDb } from "../db/surreal";
import { extractAndStoreMemories } from "../goldfish/memory";
import type { ProviderOverride } from "../middleware/types";
import { log } from "../util/logger";
import { runCompaction } from "./compaction";
import { appendAssistantOutput, updateTokenCount } from "./message-log/index";
import type { BackgroundByok } from "./provider/override-completion";

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

/**
 * Split a set of tool calls into server-side (executed internally) and
 * client-side (emitted to the caller). Single source of truth for the
 * classification.
 *
 * Classifies against the actual server ToolSet on the context — a call is
 * server-side iff a tool by that name exists in `serverTools`. Since
 * getServerTools() merges connected MCP servers' tools by construction,
 * late-connecting MCP servers classify correctly with no name-set to
 * refresh.
 *
 * Accepts Record<string, unknown> to carry providerMetadata (Google
 * thoughtSignature) and any future SDK fields without enumerating.
 */
export function classifyToolCalls(
  toolCalls: Array<Record<string, unknown>>,
  serverTools: ToolSet,
) {
  return {
    serverCalls: toolCalls.filter((tc) => String(tc.toolName) in serverTools),
    clientCalls: toolCalls.filter(
      (tc) => !(String(tc.toolName) in serverTools),
    ),
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
  toolCalls: Array<Record<string, unknown>>,
  reasoning: string | undefined,
  ctx: {
    projectId: string | null;
    providerOverride: ProviderOverride | null;
    request: { messages: ModelMessage[]; model: string };
    scope: { orgId: string };
  },
  lastStepInputTokens: number,
) {
  const projectId = ctx.projectId;
  const orgId = ctx.scope.orgId;
  if (!projectId) {
    // The pipeline's resolve stage runs before any turn — a null here is
    // an ordering bug, and persisting under a fake key would corrupt the
    // log. Skip loudly.
    log.error(
      "finalizeTurn: ctx.projectId not resolved — skipping persistence, compaction, and extraction",
    );
    return;
  }

  persistAssistantTurn(text, toolCalls, projectId, orgId, reasoning).catch(
    (err) => log.error({ err }, "persistAssistantTurn failed"),
  );

  // BYOK (MIM-74): the background jobs this turn spawns run on the turn's
  // own key when one was sent; keyless turns use the env small model.
  const byok: BackgroundByok = ctx.providerOverride
    ? { override: ctx.providerOverride, requestModelId: ctx.request.model }
    : null;

  triggerCompactionIfNeeded(
    lastStepInputTokens,
    projectId,
    orgId,
    ctx.request.model,
    byok?.override ?? null,
  );

  const lastUserMessage = [...ctx.request.messages]
    .reverse()
    .find((m) => m.role === "user");
  extractMemoriesFromResponse(
    text || null,
    lastUserMessage ?? null,
    projectId,
    orgId,
    byok,
  );
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
  projectId: string,
  orgId: string,
  modelId?: string,
  override: ProviderOverride | null = null,
) {
  updateTokenCount(orgId, promptTokens, modelId)
    .then(({ needsCompaction }) => {
      if (needsCompaction) {
        log.info({ projectId, orgId }, "triggering async compaction");
        runCompaction(orgId, modelId, override).catch((err) =>
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
 * `clientToolCalls` must already be client-only — the loop classifies via
 * classifyToolCalls before the turn finalizes, and server tool calls are
 * ephemeral by design (never persisted).
 *
 * Fire-and-forget at call sites — persistence failure must not fail the
 * response. Errors are logged. Returns immediately when there's no text
 * and no tool calls (e.g., cancellation before any emission).
 */
export async function persistAssistantTurn(
  text: string,
  clientToolCalls: Array<Record<string, unknown>>,
  projectId: string,
  orgId: string,
  reasoning?: string,
) {
  const hasText = text.trim().length > 0;
  const hasToolCalls = clientToolCalls.length > 0;
  const hasReasoning = reasoning && reasoning.trim().length > 0;
  if (!hasText && !hasToolCalls && !hasReasoning) return;

  // Spread tool call fields — carry providerMetadata (Google thoughtSignature)
  // and any future SDK fields rather than enumerating. Override `type` and
  // `input` with the persistence-compatible shapes.
  const parts: Exclude<AssistantContent, string> = [];
  if (hasReasoning) parts.push({ type: "reasoning", text: reasoning });
  if (hasText) parts.push({ type: "text", text });
  for (const tc of clientToolCalls) {
    parts.push({
      ...tc,
      type: "tool-call",
      input: tc.input,
    } as (typeof parts)[number]);
  }

  const message: ModelMessage = {
    role: "assistant",
    content: parts,
  };
  // Runs at turn end on the root connection stamped with the org (the request
  // scope may be closing under slice 5's connect-per-request).
  const scope = rootScope(await getDb(), orgId);
  await appendAssistantOutput(scope, message, projectId).catch((err) =>
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
  projectId: string,
  orgId: string,
  byok: BackgroundByok = null,
) {
  if (!assistantContent || !lastUserMessage) return;

  const messages: ModelMessage[] = [
    lastUserMessage,
    { role: "assistant", content: assistantContent },
  ];
  // Fire-and-forget after the request scope closed — extraction runs on the
  // root connection stamped with the triggering org.
  (async () => {
    const scope = rootScope(await getDb(), orgId);
    await extractAndStoreMemories(scope, messages, projectId, byok);
  })().catch((err) => log.error({ err }, "extraction error"));
}
