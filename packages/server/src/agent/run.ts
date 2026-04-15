/**
 * Agent Runner — manual doStream/doGenerate loop.
 *
 * Replaces streamText/generateText with a manual loop around model.doStream().
 * The AI SDK's multi-step agent loop caused:
 *  - MissingToolResultsError (validation before stopWhen fires)
 *  - args/input field mismatch (ModelMessage uses input, not args)
 *  - Parallel write ordering (map async broke sequential validation)
 *  - Missing arguments on zero-arg tools (providers reject omitted field)
 *
 * This module keeps the AI SDK's provider abstraction (doStream handles
 * format conversion per provider) without its multi-step pipeline.
 * We control the message lifecycle between steps.
 */

import type {
  LanguageModelV3FilePart,
  LanguageModelV3FunctionTool,
  LanguageModelV3Message,
  LanguageModelV3Prompt,
  LanguageModelV3ReasoningPart,
  LanguageModelV3TextPart,
  LanguageModelV3ToolCallPart,
  LanguageModelV3ToolResultPart,
} from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { asSchema } from "ai";
import {
  extractMemoriesFromResponse,
  triggerCompactionIfNeeded,
} from "../agent-loop/post-processing";
import { SERVER_TOOL_NAMES } from "../agent-loop/server-tools";
import type { MimirContext } from "../middleware/types";
import { log } from "../util/logger";
import {
  getReasoningOptions,
  getSamplingOptions,
  resolveModel,
} from "./provider-registry";

const MAX_AGENT_STEPS = 20;

type Model = ReturnType<typeof resolveModel>;

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the agent with the prepared context.
 * Returns an OpenAI-compatible Response (streaming or non-streaming).
 */
export function runAgent(ctx: MimirContext) {
  const model = resolveModel(ctx.request.model);
  ctx.resolvedModel = model;

  const prompt = buildPrompt(ctx);
  const tools = buildTools(ctx);
  const options = buildCallOptions(ctx, prompt, tools);

  if (ctx.request.stream) {
    return streamingResponse(model, options, ctx);
  }
  return nonStreamingResponse(model, options, ctx);
}

// ---------------------------------------------------------------------------
// Prompt conversion: ModelMessage[] → LanguageModelV3Prompt
//
// This replaces the AI SDK's convertToLanguageModelPrompt, which is where
// MissingToolResultsError lived. We do the same structural conversion
// but skip the validation that throws.
// ---------------------------------------------------------------------------

function buildPrompt(ctx: MimirContext) {
  const messages: ModelMessage[] = [
    { role: "system", content: ctx.systemPrompt },
    ...ctx.contextInjection,
    ...ctx.conversationMessages,
  ];
  return messagesToV3Prompt(messages);
}

function messagesToV3Prompt(messages: ModelMessage[]) {
  const prompt: LanguageModelV3Prompt = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system":
        prompt.push({ role: "system", content: String(msg.content ?? "") });
        break;

      case "user": {
        const content =
          typeof msg.content === "string"
            ? [{ type: "text" as const, text: msg.content }]
            : normalizeUserParts(msg.content);
        prompt.push({ role: "user", content });
        break;
      }

      case "assistant": {
        const content =
          typeof msg.content === "string"
            ? [{ type: "text" as const, text: msg.content }]
            : normalizeAssistantParts(msg.content);
        prompt.push({ role: "assistant", content });
        break;
      }

      case "tool":
        if (Array.isArray(msg.content)) {
          prompt.push({
            role: "tool",
            content: normalizeToolParts(msg.content),
          });
        }
        break;
    }
  }

  return prompt;
}

function normalizeUserParts(parts: unknown) {
  if (!parts || !Array.isArray(parts))
    return [{ type: "text" as const, text: "" }];
  const result: (LanguageModelV3TextPart | LanguageModelV3FilePart)[] = [];
  for (const p of parts) {
    if (p?.type === "file") {
      result.push({
        type: "file" as const,
        data: p.data,
        mediaType: String(
          p.mediaType ?? p.mimeType ?? "application/octet-stream",
        ),
      });
    } else {
      result.push({
        type: "text" as const,
        text: String(p?.text ?? p?.content ?? ""),
      });
    }
  }
  return result;
}

function normalizeAssistantParts(parts: unknown) {
  if (!parts || !Array.isArray(parts))
    return [{ type: "text" as const, text: "" }];
  const result: (
    | LanguageModelV3TextPart
    | LanguageModelV3ReasoningPart
    | LanguageModelV3ToolCallPart
  )[] = [];
  for (const p of parts) {
    switch (p?.type) {
      case "text":
        result.push({ type: "text" as const, text: String(p.text ?? "") });
        break;
      case "reasoning":
        result.push({ type: "reasoning" as const, text: String(p.text ?? "") });
        break;
      case "tool-call":
        // Critical: ensure input is never undefined.
        // Providers (vLLM, Chutes) reject tool calls without arguments.
        result.push({
          type: "tool-call" as const,
          toolCallId: String(p.toolCallId),
          toolName: String(p.toolName),
          input: p.input ?? {},
        });
        break;
      default:
        result.push({
          type: "text" as const,
          text: String(p?.text ?? p?.content ?? ""),
        });
        break;
    }
  }
  return result;
}

function normalizeToolParts(parts: unknown) {
  if (!parts || !Array.isArray(parts)) return [];
  const result: LanguageModelV3ToolResultPart[] = [];
  for (const p of parts) {
    if (p?.type !== "tool-result") continue;
    const output: LanguageModelV3ToolResultPart["output"] =
      p.output && typeof p.output === "object" && "type" in p.output
        ? p.output
        : { type: "text" as const, value: String(p.output ?? "") };
    result.push({
      type: "tool-result" as const,
      toolCallId: String(p.toolCallId),
      toolName: String(p.toolName),
      output,
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tool conversion: ToolSet → LanguageModelV3FunctionTool[]
//
// Extracts JSONSchema from AI SDK Tool objects. The inputSchema field
// is a Schema<T> with a .jsonSchema property (JSONSchema7, synchronous
// for tools created via tool()/jsonSchema()).
// ---------------------------------------------------------------------------

function buildTools(ctx: MimirContext) {
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

// ---------------------------------------------------------------------------
// Call options
// ---------------------------------------------------------------------------

function buildCallOptions(
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

// ---------------------------------------------------------------------------
// Streaming response
// ---------------------------------------------------------------------------

function streamingResponse(
  model: Model,
  baseOptions: ReturnType<typeof buildCallOptions>,
  ctx: MimirContext,
) {
  const streamId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const modelId = ctx.request.model;
  const encoder = new TextEncoder();

  const emitSSE = (
    controller: ReadableStreamDefaultController,
    delta: Record<string, unknown>,
    finishReason: string | null = null,
  ) => {
    const chunk = {
      id: streamId,
      object: "chat.completion.chunk",
      created,
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  };

  const readable = new ReadableStream({
    start(controller) {
      agentLoop(model, baseOptions, ctx, controller, emitSSE)
        .catch((err) => {
          log.error({ err }, "agent loop error");
          const msg = err instanceof Error ? err.message : "Agent loop error";
          emitSSE(controller, { content: `\n\n[Error: ${msg}]` });
        })
        .finally(() => {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        });
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// Agent loop — the core
//
// LOOP:
//   model.doStream(prompt, tools)
//   → stream text/reasoning deltas to SSE
//   → accumulate tool calls
//   → if no tool calls: emit finish, break
//   → classify: server vs client
//   → if client calls: emit as SSE tool_calls, break
//   → execute server tools (try/catch each, always produce a result)
//   → append assistant message + tool results to prompt
//   → continue
// ---------------------------------------------------------------------------

async function agentLoop(
  model: Model,
  baseOptions: ReturnType<typeof buildCallOptions>,
  ctx: MimirContext,
  controller: ReadableStreamDefaultController,
  emitSSE: (
    controller: ReadableStreamDefaultController,
    delta: Record<string, unknown>,
    finishReason?: string | null,
  ) => void,
) {
  const prompt: LanguageModelV3Message[] = [...(baseOptions.prompt ?? [])];
  let lastStepInputTokens = 0;
  let lastAssistantText = "";

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    log.debug({ step, promptMessages: prompt.length }, "agent step");

    const { stream } = await model.doStream({
      ...baseOptions,
      prompt,
    });

    const textChunks: string[] = [];
    const reasoningChunks: string[] = [];
    const toolCalls: Array<{
      toolCallId: string;
      toolName: string;
      input: string;
    }> = [];
    let stepInputTokens = 0;
    let stepOutputTokens = 0;
    let finishReason = "stop";

    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value: part } = await reader.read();
        if (done) break;

        switch (part.type) {
          case "text-delta":
            textChunks.push(part.delta);
            emitSSE(controller, { content: part.delta });
            break;

          case "reasoning-delta":
            reasoningChunks.push(part.delta);
            emitSSE(controller, { reasoning_content: part.delta });
            break;

          case "tool-call":
            toolCalls.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            });
            break;

          case "finish":
            finishReason = part.finishReason.unified;
            stepInputTokens = part.usage.inputTokens.total ?? 0;
            stepOutputTokens = part.usage.outputTokens.total ?? 0;
            break;

          case "error":
            log.error({ err: part.error }, "stream error");
            throw part.error instanceof Error
              ? part.error
              : new Error(String(part.error));

          default:
            break;
        }
      }
    } finally {
      reader.releaseLock();
    }

    lastStepInputTokens = stepInputTokens;
    lastAssistantText = textChunks.join("");

    log.debug(
      {
        step,
        finishReason,
        inputTokens: stepInputTokens,
        outputTokens: stepOutputTokens,
        toolCalls: toolCalls.length,
        textLength: lastAssistantText.length,
      },
      "step finished",
    );

    // No tool calls → done
    if (toolCalls.length === 0) {
      emitSSE(controller, {}, finishReason === "stop" ? "stop" : finishReason);
      break;
    }

    // Classify: server vs client
    const serverCalls = toolCalls.filter((tc) =>
      SERVER_TOOL_NAMES.has(tc.toolName),
    );
    const clientCalls = toolCalls.filter(
      (tc) => !SERVER_TOOL_NAMES.has(tc.toolName),
    );

    // Client tool calls → emit and stop
    if (clientCalls.length > 0) {
      let i = 0;
      for (const tc of clientCalls) {
        emitSSE(
          controller,
          {
            tool_calls: [
              {
                index: i,
                id: tc.toolCallId,
                type: "function",
                function: {
                  name: tc.toolName,
                  arguments: tc.input,
                },
              },
            ],
          },
          i === clientCalls.length - 1 ? "tool_calls" : null,
        );
        i++;
      }
      break;
    }

    // Server tool calls → execute and loop
    appendServerStepToPrompt(
      prompt,
      lastAssistantText,
      reasoningChunks,
      serverCalls,
    );
    await executeServerTools(prompt, serverCalls, ctx);
  }

  // Post-processing (fire-and-forget)
  triggerCompactionIfNeeded(
    lastStepInputTokens,
    ctx.project,
    ctx.request.model,
  );

  const lastUserMessage = [...ctx.request.messages]
    .reverse()
    .find((m) => m.role === "user");
  extractMemoriesFromResponse(
    lastAssistantText || null,
    lastUserMessage ?? null,
    ctx.project,
  );
}

// ---------------------------------------------------------------------------
// Non-streaming response
// ---------------------------------------------------------------------------

async function nonStreamingResponse(
  model: Model,
  baseOptions: ReturnType<typeof buildCallOptions>,
  ctx: MimirContext,
) {
  const prompt: LanguageModelV3Message[] = [...(baseOptions.prompt ?? [])];
  let lastStepInputTokens = 0;
  let lastText = "";
  let lastToolCalls: Array<{
    toolCallId: string;
    toolName: string;
    input: string;
  }> = [];
  let lastFinishReason = "stop";

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    const result = await model.doGenerate({
      ...baseOptions,
      prompt,
    });

    lastStepInputTokens = result.usage.inputTokens.total ?? 0;
    lastFinishReason = result.finishReason.unified;

    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCalls: typeof lastToolCalls = [];

    for (const part of result.content) {
      switch (part.type) {
        case "text":
          textParts.push(part.text);
          break;
        case "reasoning":
          reasoningParts.push(part.text);
          break;
        case "tool-call":
          toolCalls.push({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          });
          break;
      }
    }

    lastText = textParts.join("");
    lastToolCalls = toolCalls;

    log.debug(
      {
        step,
        finishReason: lastFinishReason,
        inputTokens: lastStepInputTokens,
        outputTokens: result.usage.outputTokens.total ?? 0,
        toolCalls: toolCalls.length,
        textLength: lastText.length,
      },
      "non-streaming step finished",
    );

    if (toolCalls.length === 0) break;

    const clientCalls = toolCalls.filter(
      (tc) => !SERVER_TOOL_NAMES.has(tc.toolName),
    );
    if (clientCalls.length > 0) {
      lastToolCalls = clientCalls;
      lastFinishReason = "tool-calls";
      break;
    }

    const serverCalls = toolCalls.filter((tc) =>
      SERVER_TOOL_NAMES.has(tc.toolName),
    );

    appendServerStepToPrompt(prompt, lastText, reasoningParts, serverCalls);
    await executeServerTools(prompt, serverCalls, ctx);
    lastToolCalls = [];
  }

  // Post-processing
  triggerCompactionIfNeeded(
    lastStepInputTokens,
    ctx.project,
    ctx.request.model,
  );

  const lastUserMessage = [...ctx.request.messages]
    .reverse()
    .find((m) => m.role === "user");
  extractMemoriesFromResponse(
    lastText || null,
    lastUserMessage ?? null,
    ctx.project,
  );

  // Build OpenAI-compatible response
  const streamId = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);

  const finishReason =
    lastFinishReason === "stop"
      ? "stop"
      : lastFinishReason === "tool-calls"
        ? "tool_calls"
        : lastFinishReason;

  return new Response(
    JSON.stringify({
      id: streamId,
      object: "chat.completion",
      created,
      model: ctx.request.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: lastText || null,
            tool_calls:
              lastToolCalls.length > 0
                ? lastToolCalls.map((tc) => ({
                    id: tc.toolCallId,
                    type: "function" as const,
                    function: {
                      name: tc.toolName,
                      arguments: tc.input,
                    },
                  }))
                : undefined,
          },
          finish_reason: finishReason,
        },
      ],
      usage: {
        prompt_tokens: lastStepInputTokens,
        completion_tokens: 0,
        total_tokens: lastStepInputTokens,
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}

// ---------------------------------------------------------------------------
// Shared: server tool step handling
// ---------------------------------------------------------------------------

/**
 * Append assistant message with text + reasoning + tool calls to the prompt.
 */
function appendServerStepToPrompt(
  prompt: LanguageModelV3Message[],
  text: string,
  reasoning: string[],
  toolCalls: Array<{ toolCallId: string; toolName: string; input: string }>,
) {
  const parts: Array<
    | LanguageModelV3TextPart
    | LanguageModelV3ReasoningPart
    | LanguageModelV3ToolCallPart
  > = [];
  if (text) parts.push({ type: "text", text });
  if (reasoning.length > 0) {
    parts.push({ type: "reasoning", text: reasoning.join("") });
  }
  for (const tc of toolCalls) {
    parts.push({
      type: "tool-call",
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      input: safeParseJSON(tc.input),
    });
  }
  prompt.push({ role: "assistant", content: parts });
}

/**
 * Execute server tools sequentially, always producing a result.
 * Appends tool result message to prompt.
 */
async function executeServerTools(
  prompt: LanguageModelV3Message[],
  toolCalls: Array<{ toolCallId: string; toolName: string; input: string }>,
  ctx: MimirContext,
) {
  const toolResults: LanguageModelV3ToolResultPart[] = [];

  for (const tc of toolCalls) {
    const tool = ctx.serverTools[tc.toolName];
    const parsedInput = safeParseJSON(tc.input);
    let resultValue: string;

    if (!tool?.execute) {
      resultValue = `Error: tool ${tc.toolName} has no execute function`;
    } else {
      try {
        const result = await tool.execute(parsedInput, {
          toolCallId: tc.toolCallId,
          messages: [],
          abortSignal: undefined,
        });
        resultValue =
          typeof result === "string" ? result : JSON.stringify(result ?? "");
      } catch (err) {
        log.error(
          { err, toolName: tc.toolName },
          "server tool execution failed",
        );
        resultValue = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    toolResults.push({
      type: "tool-result" as const,
      toolCallId: tc.toolCallId,
      toolName: tc.toolName,
      output: { type: "text" as const, value: resultValue },
    });
  }

  prompt.push({ role: "tool", content: toolResults });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseJSON(str: string) {
  try {
    return JSON.parse(str);
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "safeParseJSON failed, returning raw string",
    );
    return str;
  }
}
