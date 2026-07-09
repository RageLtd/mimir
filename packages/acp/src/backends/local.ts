/**
 * Local backend — the MIM-89 inversion.
 *
 * One backend.run = one model turn, executed entirely in-process on the
 * plugin-core engine: resolve the model from the local provider registry
 * (BYOK keys come from standard env vars in the editor's env block),
 * convert the session's wire messages to a V3 prompt, drive a single
 * streamTurn, and translate TurnEvents into BackendEvents. No HTTP, no
 * SSE — the prompt never leaves the machine except to the model provider.
 *
 * Prompt composition mirrors the dead server buildPrompt exactly:
 * [system prompt, ...context injection pair, ...conversation]. The host
 * (prompt-server) prepends the synthetic context pair to `messages`, so
 * this module only adds the system message.
 *
 * Every tool call is a real request for the agent loop to execute — the
 * observe-only leg died with the server backend.
 */

import {
  getContextWindow,
  getModelProvider,
  getProviderEnvVar,
  getReasoningOptions,
  resolveModel,
} from "@mimir/plugin-core/engine/provider";
import { redactSecret } from "@mimir/plugin-core/engine/redact";
import {
  messagesToV3Prompt,
  normalizeMessages,
  sanitizeToolMessages,
  streamTurn,
  toolDefsToV3FunctionTools,
} from "@mimir/plugin-core/engine/turn";
import { errMessage } from "@mimir/plugin-core/util";
import type { Backend, BackendRunOptions } from "./types";

/**
 * The provider API key that served this model, read from the standard env
 * var the registry itself uses. Threaded into redactSecret so a provider
 * error can never echo the credential into the editor or the session log.
 */
const providerKeyFor = (modelId: string) => {
  const providerId = getModelProvider(modelId);
  const envVar = providerId ? getProviderEnvVar(providerId) : undefined;
  return envVar ? process.env[envVar] || undefined : undefined;
};

export const createLocalBackend = () => {
  const run = async function* (options: BackendRunOptions) {
    const secret = providerKeyFor(options.modelId);
    const fail = (err: unknown) => ({
      type: "error" as const,
      error: redactSecret(errMessage(err), secret),
    });

    // resolveModel throws synchronously on an unknown model or an
    // uninitialized registry. The async-arrow wrap folds the sync throw
    // into the promise chain (MIM-74 pattern — a bare .catch would only
    // convert rejections), so it surfaces as an explicit error event.
    const resolved = await Promise.resolve()
      .then(() => ({
        ok: true as const,
        model: resolveModel(options.modelId),
      }))
      .catch((err: unknown) => ({ ok: false as const, event: fail(err) }));
    if (!resolved.ok) {
      yield resolved.event;
      return;
    }
    const model = resolved.model;

    // Wire → ModelMessage → V3, same order as the server's buildPrompt:
    // system first, then the (already prepended) injection pair and the
    // conversation. sanitizeToolMessages is identity for non-tool turns.
    const wireMessages = [
      { role: "system", content: options.systemPrompt },
      ...options.messages,
    ];
    const prompt = messagesToV3Prompt(
      sanitizeToolMessages(normalizeMessages(wireMessages)),
    );

    const iter = streamTurn({
      model,
      prompt,
      tools: toolDefsToV3FunctionTools(options.tools),
      providerOptions: getReasoningOptions(options.modelId, options.effort),
      signal: options.signal,
    })[Symbol.asyncIterator]();

    // streamTurn THROWS on failure (doStream error, in-stream error part,
    // stall timeout) — drive manually with .next().catch() so the throw
    // becomes an explicit error event, per the established ACP pattern.
    while (true) {
      const step = await iter.next().catch((err: unknown) => fail(err));
      if ("type" in step) {
        yield step;
        return;
      }
      if (step.done) break;
      const event = step.value;

      switch (event.type) {
        case "text":
          yield { type: "text" as const, text: event.text };
          break;
        case "thinking":
          yield { type: "thinking" as const, text: event.text };
          break;
        case "tool_call":
          yield {
            type: "tool_call" as const,
            id: event.id,
            name: event.name,
            input: event.input,
          };
          break;
        case "finish":
          yield {
            type: "finish" as const,
            stopReason: event.reason,
            ...(event.inputTokens > 0
              ? { promptTokens: event.inputTokens }
              : {}),
            ...(event.outputTokens > 0
              ? { completionTokens: event.outputTokens }
              : {}),
            ...(() => {
              const contextWindow = getContextWindow(options.modelId);
              return typeof contextWindow === "number" ? { contextWindow } : {};
            })(),
          };
          break;
      }
    }
  };

  return { kind: "local", run } satisfies Backend;
};
