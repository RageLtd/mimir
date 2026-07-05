/**
 * Phase 6: Async Compaction
 *
 * Token-based compaction triggered when tokensSinceLastCompaction >= contextWindow * 0.8.
 * Runs asynchronously after response completes — no request latency impact.
 *
 * Compaction creates a new timestamped summary entry in Goldfish (type: "summary"),
 * not overwriting previous summaries. Context assembly fetches last N summaries
 * and compresses them together, preserving more signal than rolling summaries.
 *
 * Global state:
 * - Compaction state is singular (one row) since the message log is global
 * - Summaries carry no project_id — they compact the global log, so the
 *   optional field stays unset rather than holding a fake sentinel
 */

import { embedOne } from "../goldfish/clients";
import { getLastSummaries, storeMemory } from "../goldfish/store";
import type { ProviderOverride } from "../middleware/types";
import { log } from "../util/logger";
import { attempt } from "../util/result";
import {
  finishCompaction,
  getCompactionState,
  startCompaction,
} from "./message-log/compaction-state";
import { modelContentToString } from "./message-log/message-utils";
import { getModelMessagesSince } from "./message-log/persistence";
import {
  resolveOverrideModelId,
  runOverrideCompletion,
} from "./provider/override-completion";
import {
  getProviderConfigForModel,
  getSmallModelConfig,
} from "./provider/query";

// ---------------------------------------------------------------------------
// Async Compaction
// ---------------------------------------------------------------------------

/**
 * Run compaction asynchronously.
 * Called after response completes when threshold is reached.
 *
 * `override` (MIM-74): the triggering turn's BYOK key — summarization runs
 * on the user's key when present, the env small model otherwise.
 */
export async function runCompaction(
  modelId?: string,
  override: ProviderOverride | null = null,
) {
  const start = Date.now();

  // Mark as compacting to prevent concurrent runs
  const started = await startCompaction();
  if (!started) {
    log.warn("compaction already in progress, skipping");
    return;
  }

  try {
    // Get messages since last summary
    const state = await getCompactionState();
    const lastCompaction = state?.last_compaction
      ? new Date(state.last_compaction)
      : new Date(0);

    const messages = await getModelMessagesSince(lastCompaction);

    if (messages.length < 10) {
      log.info(
        { messageCount: messages.length },
        "not enough messages for compaction, skipping",
      );
      await finishCompaction();
      return;
    }

    // Build conversation text for summarization
    // Include ALL messages but truncate massive tool results.
    // Skip the synthetic context injection pair — those are prior summaries
    // echoed back into the conversation and would cause the summarizer to
    // re-summarize already-covered material.
    const conversationText = messages
      .map((m) => {
        if (m.role === "tool") {
          const text = modelContentToString(m.content);
          if (text.length > 500) {
            return `${m.role}: ${text.slice(0, 500)}... [truncated]`;
          }
          return `${m.role}: ${text}`;
        }

        const text = modelContentToString(m.content);
        if (!text) return null;

        // Skip context injection pair (summaries/memories injected at session start)
        if (text.startsWith("Session context:")) return null;
        if (m.role === "assistant" && text === "Understood.") return null;

        // Skip messages that are mostly tool result XML noise
        if (text.includes("<websearch>") || text.includes("<context7>"))
          return null;

        return `${m.role}: ${text}`;
      })
      .filter(Boolean)
      .join("\n");

    if (conversationText.length < 200) {
      log.info(
        { charCount: conversationText.length },
        "conversation too short for compaction, skipping",
      );
      await finishCompaction();
      return;
    }

    // Fetch the most recent summary so the summarizer knows what's
    // already been captured and can focus on genuinely new content
    const previousSummaries = await getLastSummaries(1);
    const previousSummary = previousSummaries[0]?.content ?? null;

    // Call memgen API for summarization
    const summary = await summarizeConversation(
      conversationText,
      modelId,
      previousSummary,
      override,
    );

    if (!summary) {
      log.error("summarization failed, skipping compaction");
      await finishCompaction();
      return;
    }

    // Store summary as Goldfish memory. No project_id — the summary spans
    // the global message log, so it stays a global memory.
    const embedding = await embedOne(summary);
    if (!embedding) {
      log.error("failed to embed summary");
      await finishCompaction();
      return;
    }

    const summaryId = await storeMemory({
      content: summary,
      type: "summary",
      message_count: messages.length,
      embedding,
    });

    if (!summaryId) {
      log.error("failed to store summary");
      await finishCompaction();
      return;
    }

    log.info(
      {
        summaryId,
        messageCount: messages.length,
        summaryChars: summary.length,
        elapsed: `${Date.now() - start}ms`,
      },
      "compaction complete",
    );

    await finishCompaction();
  } catch (err) {
    log.error({ err }, "compaction failed");
    await finishCompaction();
  }
}

// ---------------------------------------------------------------------------
// Summarization
// ---------------------------------------------------------------------------

interface ChatCompletionResponse {
  choices?: Array<{
    message: { content: string };
  }>;
  error?: { message: string; type?: string; code?: string };
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

const SUMMARIZATION_PROMPT = `You summarize conversations into concise context that preserves all important information for continuing the conversation. Include:
- Key decisions made and their rationale
- Current task state and progress
- Important technical details (file paths, function names, architecture choices)
- Any unresolved questions or pending work
- User preferences and constraints mentioned

Output a clear, dense summary in 2-4 paragraphs. Do not include pleasantries or meta-commentary.`;

const DELTA_SUMMARIZATION_PROMPT = `You summarize conversations into concise context that preserves all important information for continuing the conversation. A previous summary already exists covering earlier conversation. Your job is to produce a NEW summary that captures only what happened SINCE that summary.

Do NOT repeat information from the previous summary. Focus exclusively on:
- New decisions made since the previous summary
- Changes in task state or progress
- New technical details (file paths, function names, architecture choices)
- Newly unresolved questions or newly completed work
- Any corrections to information in the previous summary

If the previous summary contains an error or something that has since changed, note the correction. Otherwise, assume it is accurate and do not restate it.

Output a clear, dense summary in 1-3 paragraphs covering ONLY the delta. Do not include pleasantries or meta-commentary.`;

function resolveSummarizationModel(modelId?: string) {
  // Prefer the small model for summarization — it's cheaper, faster,
  // and perfectly adequate for utility tasks. Fall back to the request
  // model only when no small model is configured.
  const smallModel = getSmallModelConfig();
  if (smallModel) {
    return {
      baseUrl: smallModel.baseUrl,
      apiKey: smallModel.apiKey || undefined,
      model: smallModel.model,
    };
  }

  // No small model configured — try the request model as a last resort
  if (modelId) {
    const providerCfg = getProviderConfigForModel(modelId);
    if (providerCfg) {
      log.info(
        { modelId },
        "no small model configured, using request model for summarization",
      );
      return {
        baseUrl: providerCfg.baseUrl,
        apiKey: providerCfg.apiKey,
        model: modelId.includes("/")
          ? modelId.split("/").slice(1).join("/")
          : modelId,
      };
    }
  }

  log.warn(
    { modelId },
    "no provider config and no small model configured, skipping summarization",
  );
  return null;
}

const SUMMARIZATION_MAX_TOKENS = 8192;
const SUMMARIZATION_TIMEOUT_MS = 120_000;

async function summarizeConversation(
  conversationText: string,
  modelId?: string,
  previousSummary?: string | null,
  override: ProviderOverride | null = null,
) {
  const start = Date.now();

  // When a previous summary exists, use the delta prompt so the model
  // focuses on genuinely new content instead of re-summarizing old material
  const systemPrompt = previousSummary
    ? DELTA_SUMMARIZATION_PROMPT
    : SUMMARIZATION_PROMPT;

  const userContent = previousSummary
    ? `<previous_summary>\n${previousSummary}\n</previous_summary>\n\n<new_conversation>\n${conversationText}\n</new_conversation>`
    : conversationText;

  // BYOK (MIM-74): summarize on the triggering turn's key. No env fallback
  // on failure — a keyed job that errors must not silently bill the
  // operator. Only a key with no resolvable model degrades to the env path.
  if (override) {
    const overrideModelId = resolveOverrideModelId(override, modelId);
    if (overrideModelId) {
      return runOverrideCompletion({
        system: systemPrompt,
        user: userContent,
        maxOutputTokens: SUMMARIZATION_MAX_TOKENS,
        timeoutMs: SUMMARIZATION_TIMEOUT_MS,
        modelId: overrideModelId,
        override,
      });
    }
    log.warn(
      "BYOK summarization: key sent without small_model or request model — using env small model",
    );
  }

  // Resolve a model for summarization. Try the request model first (it may be
  // a server-side provider like vLLM), then fall back to the small model config
  // which is always appropriate for utility tasks like summarization.
  const resolved = resolveSummarizationModel(modelId);
  if (!resolved) return null;

  const { baseUrl, apiKey, model } = resolved;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const [err, res] = await attempt(() =>
    fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(SUMMARIZATION_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0.1,
        max_tokens: SUMMARIZATION_MAX_TOKENS,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
    }).then((r) => r.json() as Promise<ChatCompletionResponse>),
  );

  if (err) {
    log.error({ err }, "summarization request failed");
    return null;
  }

  // Check for API error response
  if (res.error) {
    log.error({ error: res.error, model }, "summarization API error");
    return null;
  }

  const content = res.choices?.[0]?.message?.content?.trim();
  if (!content) {
    log.error(
      { model, response: JSON.stringify(res).slice(0, 500) },
      "summarization returned empty content",
    );
    return null;
  }

  log.debug(
    {
      promptTokens: res.usage?.prompt_tokens,
      completionTokens: res.usage?.completion_tokens,
      elapsed: `${Date.now() - start}ms`,
    },
    "summarization complete",
  );

  return content;
}
