/**
 * BYOK background completion (MIM-74) — single-shot system+user inference
 * on the requesting user's key for the jobs a turn spawns (memory
 * extraction, compaction summarization).
 *
 * The override is transient: held in memory for the async work only, never
 * persisted. Errors are value-scrubbed (redactSecret) before logging —
 * provider SDK errors can echo request headers mid-string.
 *
 * Deliberately no env fallback here: a keyed turn's background job failing
 * must NOT silently bill the operator instead. Callers fall back to the
 * env-configured small model only when the turn carried no key at all.
 */

import { generateText } from "ai";

import type { ProviderOverride } from "../../middleware/types";
import { log } from "../../util/logger";
import { redactSecret } from "../../util/redact";
import { attempt } from "../../util/result";
import { resolveModelWithOverride } from "./query";

/**
 * BYOK context for the background jobs a turn spawns (MIM-74). Transient —
 * held in memory for the async work only, never persisted. Null when the
 * turn carried no key: the env-configured small model serves as before.
 */
export type BackgroundByok = {
  override: ProviderOverride;
  /** The turn's request model — fallback job model when the client sent
   * no metadata.small_model. Absent on persist POSTs (no request model). */
  requestModelId?: string;
} | null;

/**
 * Model choice for a keyed turn's background jobs: the client-designated
 * small model when sent (metadata.small_model), otherwise the turn's own
 * request model — the user's key, the user's bill, and always resolvable.
 * Null only when neither is known (e.g. a persist POST carrying a key but
 * no model hint) — callers treat that as keyless.
 */
export function resolveOverrideModelId(
  override: ProviderOverride,
  requestModelId?: string,
) {
  return override.smallModel ?? requestModelId ?? null;
}

export async function runOverrideCompletion(opts: {
  system: string;
  user: string;
  maxOutputTokens: number;
  temperature?: number;
  timeoutMs: number;
  modelId: string;
  override: ProviderOverride;
}) {
  const start = Date.now();

  // Async arrow on purpose: resolveModelWithOverride throws synchronously
  // (unknown provider, missing base URL) and attempt() only converts
  // rejections — the async wrapper folds the sync throw into the Result.
  const [err, result] = await attempt(async () =>
    generateText({
      model: resolveModelWithOverride(opts.modelId, opts.override),
      system: opts.system,
      prompt: opts.user,
      maxOutputTokens: opts.maxOutputTokens,
      temperature: opts.temperature ?? 0.1,
      abortSignal: AbortSignal.timeout(opts.timeoutMs),
    }),
  );

  if (err) {
    log.error(
      {
        err: redactSecret(err.message, opts.override.apiKey),
        modelId: opts.modelId,
        byok: true,
      },
      "BYOK background completion failed",
    );
    return null;
  }

  const content = result.text.trim();
  if (!content) {
    log.error(
      { modelId: opts.modelId, byok: true },
      "BYOK background completion returned empty content",
    );
    return null;
  }

  log.debug(
    {
      modelId: opts.modelId,
      byok: true,
      promptTokens: result.usage?.inputTokens,
      completionTokens: result.usage?.outputTokens,
      elapsed: `${Date.now() - start}ms`,
    },
    "BYOK background completion complete",
  );
  return content;
}
