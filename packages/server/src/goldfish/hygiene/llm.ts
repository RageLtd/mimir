/**
 * Hygiene model client — routes consolidation judgment to a deliberately
 * capable model (GLM-5.1 over opencode-go by default), separate from the small
 * Vulkan-bound extraction model.
 *
 * Env-only by design: if HYGIENE_MODEL is unset, getHygieneModelConfig returns
 * null and the sweep refuses to run rather than silently merging memories with
 * whatever model happens to be configured elsewhere.
 */

import { config } from "../../config";
import { log } from "../../util/logger";
import { attempt } from "../../util/result";

const MERGE_SYSTEM_PROMPT = `You consolidate overlapping development memories into one.

You are given several short factual statements that describe the SAME thing in slightly different words or from slightly different angles. Fuse them into a SINGLE crisp memory that:
- preserves every distinct specific (numbers, names, file paths, decisions, reasons)
- drops only the redundancy between them
- invents NOTHING not present in the inputs
- reads as one standalone fact useful in a FUTURE conversation

Output ONLY the merged statement as plain text. No preamble, no quotes, no JSON, no bullet points.`;

interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string; reasoning_content?: string };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface HygieneModelConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

/** Resolve the hygiene model config, or null when HYGIENE_MODEL is unset. */
export function getHygieneModelConfig(): HygieneModelConfig | null {
  const { model, baseUrl, apiKey } = config.hygiene;
  if (!model) return null;
  const normalizedBase = baseUrl.replace(/\/v1$/, "");
  return { baseUrl: normalizedBase, apiKey, model };
}

/**
 * Ask the hygiene model to merge a cluster of memory contents into one
 * canonical statement. Returns the merged text, or null on failure (the caller
 * then leaves the cluster untouched rather than guessing).
 */
export async function mergeMemoriesText(
  contents: string[],
): Promise<string | null> {
  const cfg = getHygieneModelConfig();
  if (!cfg) {
    log.warn("HYGIENE_MODEL unset — cannot consolidate");
    return null;
  }

  const userContent = contents.map((c, i) => `${i + 1}. ${c}`).join("\n");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const [err, res] = await attempt(() =>
    fetch(`${cfg.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        temperature: 0.1,
        // Reasoning models (GLM-5.1) spend tokens thinking before they answer.
        // Too small a budget and the whole allowance goes to reasoning, leaving
        // `content` empty — so this is generous, the merged text itself is tiny.
        max_tokens: config.hygiene.maxTokens,
        messages: [
          { role: "system", content: MERGE_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    }).then((r) => r.json() as Promise<ChatCompletionResponse>),
  );

  if (err) {
    log.error(
      { err, count: contents.length },
      "consolidation model call failed",
    );
    return null;
  }

  const choice = res.choices?.[0];
  const merged = choice?.message?.content?.trim();
  if (!merged) {
    // Surface WHY it's empty: finish_reason "length" = truncated (bump
    // max_tokens); reasoning present with empty content = same story.
    log.error(
      {
        finishReason: choice?.finish_reason,
        reasoningChars: choice?.message?.reasoning_content?.length ?? 0,
        completionTokens: res.usage?.completion_tokens,
        maxTokens: config.hygiene.maxTokens,
      },
      "consolidation model returned empty content",
    );
    return null;
  }

  log.debug(
    {
      inputs: contents.length,
      mergedChars: merged.length,
      promptTokens: res.usage?.prompt_tokens,
      completionTokens: res.usage?.completion_tokens,
    },
    "consolidation merge produced",
  );
  return merged;
}
