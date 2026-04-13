import { createOpenAI } from "@ai-sdk/openai";
import type { SharedV3ProviderOptions } from "@ai-sdk/provider";
import { wrapLanguageModel } from "ai";
import { config } from "../../config";
import { log } from "../../util/logger";
import { mistralToolCallMiddleware } from "./mistral-middleware";
import {
  getContextWindow,
  getModelMetadata,
  getModelNpm,
  getModelProvider,
  hasModel,
  hasProvider,
  resolveModel as registryResolveModel,
} from "./registry";

// Local providers
const vllmProvider = createOpenAI({
  baseURL: `${config.vllm.baseUrl}/v1`,
  apiKey: "not-needed",
});

export const vllm = (modelId: string) => vllmProvider.chat(modelId);
export const defaultModel = config.vllm.model;

const ollamaProvider = createOpenAI({
  baseURL: `${config.ollama.baseUrl}/v1`,
  apiKey: "not-needed",
});

export const ollama = (modelId: string) => ollamaProvider.chat(modelId);

const embeddingProvider = createOpenAI({
  baseURL: `${config.embedding.baseUrl}/v1`,
  apiKey: config.embedding.apiKey || "not-needed",
});

export const embeddingModel = () =>
  embeddingProvider.embedding(config.embedding.model);

export function isMistralModel(modelId: string): boolean {
  return modelId.toLowerCase().startsWith("mistral");
}

// Model routing
//
// Simplified: toolCallArgsPatchMiddleware is no longer needed.
// The manual agent loop in run.ts patches tool-call input directly
// when building the V3 prompt. Only Mistral middleware remains
// for local Mistral models that need streaming parse fixes.
export function resolveModel(modelId: string) {
  if (isMistralModel(modelId) && !hasModel(modelId)) {
    log.debug({ modelId }, "routing through vLLM + Mistral middleware");
    return wrapLanguageModel({
      model: vllm(modelId),
      middleware: mistralToolCallMiddleware,
    });
  }

  return registryResolveModel(modelId);
}

// Re-exports from provider-registry
export {
  getContextWindow,
  getModelMetadata,
  getModelNpm,
  getModelProvider,
  hasModel,
  hasProvider,
};

// Reasoning options - derived from provider-data.json metadata
function effortToBudget(
  effort: string | undefined,
  defaultBudget: number,
): number | null {
  if (!effort) return defaultBudget;
  switch (effort.toLowerCase()) {
    case "none":
      return null;
    case "low":
      return Math.round(defaultBudget * 0.25);
    case "medium":
      return Math.round(defaultBudget * 0.5);
    case "high":
      return defaultBudget;
    default:
      return defaultBudget;
  }
}

export function getReasoningOptions(
  modelId: string,
  effort?: string,
): SharedV3ProviderOptions {
  const meta = getModelMetadata(modelId);
  const providerId = getModelProvider(modelId);

  // Featherless: Qwen models have thinking enabled by default.
  // Explicitly disable it unless reasoning is requested, because
  // the thinking tokens eat the 32K context window and the
  // openai-compatible SDK can't parse reasoning_content.
  if (providerId === "featherless") {
    return {
      "openai-compatible": {
        chat_template_kwargs: { enable_thinking: false },
      },
    };
  }

  // No reasoning support
  if (!meta?.reasoning) return {};

  // OpenRouter handles reasoning via its own param
  if (providerId === "openrouter") return {};

  // Get SDK type to determine options shape
  const npm = getModelNpm(modelId);
  const budget = effortToBudget(effort, 8192);

  if (npm === "@ai-sdk/anthropic") {
    if (budget === null) return {};
    return {
      anthropic: {
        thinking: { type: "enabled" as const, budgetTokens: budget },
      },
    };
  }

  if (npm === "@ai-sdk/google" || npm === "@ai-sdk/google-vertex") {
    if (budget === null) return {};
    return { google: { thinkingConfig: { thinkingBudget: budget } } };
  }

  if (npm === "@ai-sdk/moonshotai") {
    if (budget === null) return {};
    return {
      moonshotai: {
        thinking: { type: "enabled" as const, budgetTokens: budget },
        reasoningHistory: "interleaved" as const,
      },
    };
  }

  // OpenAI and OpenAI-compatible use reasoningEffort
  if (npm === "@ai-sdk/openai" || npm === "@ai-sdk/openai-compatible") {
    return { openai: { reasoningEffort: effort ?? "high" } };
  }

  return {};
}

/**
 * Get sampling parameters for a model/provider.
 * Some providers (e.g. Featherless) need explicit sampling params
 * because the model defaults produce degenerate output without them.
 */
export function getSamplingOptions(modelId: string): {
  temperature?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
} {
  const providerId = getModelProvider(modelId);

  if (providerId === "featherless") {
    // Qwen3.5 recommended parameters from official docs
    return {
      temperature: 0.7,
      topP: 0.8,
      topK: 20,
      presencePenalty: 1.5,
    };
  }

  return {};
}
