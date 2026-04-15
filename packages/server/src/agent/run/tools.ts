/**
 * Tool and call-options conversion for the agent runner.
 *
 * Extracts JSONSchema from AI SDK Tool objects and builds the
 * options object passed to model.doStream/doGenerate.
 */

import type {
  LanguageModelV3FunctionTool,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";
import { asSchema } from "ai";
import type { MimirContext } from "../../middleware/types";
import { getReasoningOptions, getSamplingOptions } from "../provider-registry";

export function buildTools(ctx: MimirContext) {
  if (Object.keys(ctx.allTools).length === 0) return undefined;

  const tools: LanguageModelV3FunctionTool[] = [];

  for (const [name, toolDef] of Object.entries(ctx.allTools)) {
    const schema = asSchema(toolDef.inputSchema);
    const resolved = schema.jsonSchema;

    // All our tools use jsonSchema() which is synchronous.
    // Guard against PromiseLike just in case.
    const raw =
      resolved && typeof resolved === "object" && "then" in resolved
        ? { type: "object" as const, properties: {} }
        : resolved;

    // Strip $schema — some providers reject it
    const { $schema, ...cleanSchema } = raw;

    tools.push({
      type: "function",
      name,
      description: toolDef.description ?? `Tool: ${name}`,
      inputSchema: cleanSchema as LanguageModelV3FunctionTool["inputSchema"],
    });
  }

  return tools;
}

export function buildCallOptions(
  ctx: MimirContext,
  prompt: LanguageModelV3Prompt,
  tools: LanguageModelV3FunctionTool[] | undefined,
) {
  const sampling = getSamplingOptions(ctx.request.model);
  const reasoning = getReasoningOptions(
    ctx.request.model,
    ctx.request.reasoning_effort ?? undefined,
  );

  return {
    prompt,
    tools,
    temperature: sampling.temperature,
    topP: sampling.topP,
    topK: sampling.topK,
    presencePenalty: sampling.presencePenalty,
    providerOptions: reasoning,
  };
}
