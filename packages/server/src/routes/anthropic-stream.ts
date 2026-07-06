/**
 * Anthropic Messages API streaming response — state machine + wrapper.
 *
 * Two-layer design. The lower layer is a pure state machine that maps
 * the agent loop's OpenAI-shape delta callbacks onto Anthropic SSE
 * event objects: `processTextDelta`, `processReasoningDelta`,
 * `processToolCalls`, `processFinish`, `processUsage` each take
 * current state + input and return `{ state, events }`. The upper
 * layer (`anthropicStreamingResponse`) is thin glue — holds the state
 * in closure, calls the pure helpers, writes events onto the
 * outbound ReadableStream.
 *
 * Event constructors live in `anthropic-stream-events.ts`; this file
 * is logic only.
 */

import { enqueueLlmCall } from "../agent/queue";
import {
  agentLoop,
  type EmitSSE,
  type EmitUsage,
  type Model,
} from "../agent/run/loop";
import { prepareTurn } from "../agent/run/turn";
import { closeScope } from "../db/scope";
import type { MimirContext } from "../middleware/types";
import { log } from "../util/logger";
import { redactSecret } from "../util/redact";
import {
  type AnthropicEvent,
  buildContentBlockStartText,
  buildContentBlockStartThinking,
  buildContentBlockStartToolUse,
  buildContentBlockStop,
  buildInputJsonDelta,
  buildMessageDelta,
  buildMessageStart,
  buildMessageStop,
  buildTextDelta,
  buildThinkingDelta,
} from "./anthropic-stream-events";

export type { AnthropicEvent } from "./anthropic-stream-events";

export type AnthropicBlockType = "text" | "thinking" | null;

export type AnthropicStreamState = {
  messageStarted: boolean;
  currentBlockIndex: number;
  currentBlockType: AnthropicBlockType;
  pendingFinishReason: string | null;
};

export type AnthropicToolCallDelta = {
  id: string;
  name: string;
  arguments: string;
};

export const initialAnthropicStreamState = () => ({
  messageStarted: false,
  currentBlockIndex: -1,
  currentBlockType: null,
  pendingFinishReason: null,
});

// ---------------------------------------------------------------------------
// State machine helpers — internal building blocks for the public
// processors below. Each takes state and returns new state + events.
// ---------------------------------------------------------------------------

/**
 * Translate the agent loop's finish reason (OpenAI/AI-SDK style) into
 * Anthropic's stop_reason vocabulary. Falls back to end_turn for
 * unknown values so the stream always closes with a valid Anthropic
 * stop_reason.
 */
const translateStopReason = (finishReason: string | null) => {
  if (!finishReason) return "end_turn";
  switch (finishReason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "tool-calls":
      return "tool_use";
    default:
      return "end_turn";
  }
};

const ensureMessageStarted = (
  state: AnthropicStreamState,
  modelId: string,
  messageId: string,
) => {
  if (state.messageStarted) {
    return { state, events: [] as AnthropicEvent[] };
  }
  return {
    state: { ...state, messageStarted: true },
    events: [buildMessageStart(modelId, messageId)],
  };
};

const closeCurrentBlock = (state: AnthropicStreamState) => {
  if (state.currentBlockType === null) {
    return { state, events: [] as AnthropicEvent[] };
  }
  const events: AnthropicEvent[] = [
    buildContentBlockStop(state.currentBlockIndex),
  ];
  const nextType: AnthropicBlockType = null;
  return {
    state: { ...state, currentBlockType: nextType },
    events,
  };
};

const ensureTextBlock = (state: AnthropicStreamState) => {
  if (state.currentBlockType === "text") {
    return { state, events: [] as AnthropicEvent[] };
  }
  const events: AnthropicEvent[] = [];
  let s = state;
  if (s.currentBlockType !== null) {
    events.push(buildContentBlockStop(s.currentBlockIndex));
  }
  const newIndex = s.currentBlockIndex + 1;
  events.push(buildContentBlockStartText(newIndex));
  s = { ...s, currentBlockIndex: newIndex, currentBlockType: "text" };
  return { state: s, events };
};

const ensureThinkingBlock = (state: AnthropicStreamState) => {
  if (state.currentBlockType === "thinking") {
    return { state, events: [] as AnthropicEvent[] };
  }
  const events: AnthropicEvent[] = [];
  let s = state;
  if (s.currentBlockType !== null) {
    events.push(buildContentBlockStop(s.currentBlockIndex));
  }
  const newIndex = s.currentBlockIndex + 1;
  events.push(buildContentBlockStartThinking(newIndex));
  s = { ...s, currentBlockIndex: newIndex, currentBlockType: "thinking" };
  return { state: s, events };
};

// ---------------------------------------------------------------------------
// Public processors — called by the streaming wrapper for each delta
// type the agent loop emits.
// ---------------------------------------------------------------------------

/**
 * Process a text-delta from the agent loop. Lazily emits message_start
 * and content_block_start (opening a text block, closing any open
 * non-text block first).
 */
export const processTextDelta = (
  state: AnthropicStreamState,
  text: string,
  modelId: string,
  messageId: string,
) => {
  const started = ensureMessageStarted(state, modelId, messageId);
  const opened = ensureTextBlock(started.state);
  return {
    state: opened.state,
    events: [
      ...started.events,
      ...opened.events,
      buildTextDelta(opened.state.currentBlockIndex, text),
    ],
  };
};

/**
 * Process a reasoning-delta from the agent loop. Emits Anthropic
 * thinking blocks — required for reasoning-capable models that emit
 * the bulk of their tokens through `reasoning-delta` rather than
 * `text-delta`.
 */
export const processReasoningDelta = (
  state: AnthropicStreamState,
  thinking: string,
  modelId: string,
  messageId: string,
) => {
  const started = ensureMessageStarted(state, modelId, messageId);
  const opened = ensureThinkingBlock(started.state);
  return {
    state: opened.state,
    events: [
      ...started.events,
      ...opened.events,
      buildThinkingDelta(opened.state.currentBlockIndex, thinking),
    ],
  };
};

/**
 * Process a batch of tool calls from the agent loop. Each tool call
 * becomes a complete tool_use content block — start, single
 * input_json_delta with full arguments JSON, stop. The agent loop
 * hands us the complete arguments string in one go, so we do the same
 * rather than character-streaming.
 *
 * Any currently-open text or thinking block is closed before the first
 * tool_use block opens.
 */
export const processToolCalls = (
  state: AnthropicStreamState,
  toolCalls: AnthropicToolCallDelta[],
  modelId: string,
  messageId: string,
) => {
  const started = ensureMessageStarted(state, modelId, messageId);
  const closed = closeCurrentBlock(started.state);

  let s = closed.state;
  const events: AnthropicEvent[] = [...started.events, ...closed.events];

  for (const tc of toolCalls) {
    const newIndex = s.currentBlockIndex + 1;
    events.push(buildContentBlockStartToolUse(newIndex, tc.id, tc.name));
    events.push(buildInputJsonDelta(newIndex, tc.arguments));
    events.push(buildContentBlockStop(newIndex));
    s = { ...s, currentBlockIndex: newIndex, currentBlockType: null };
  }

  return { state: s, events };
};

/**
 * Record the agent loop's finish reason for later emission inside the
 * terminal message_delta. The agent loop calls emitSSE with the finish
 * reason before emitUsage fires, so we buffer here and act on it in
 * processUsage.
 */
export const processFinish = (
  state: AnthropicStreamState,
  finishReason: string | null,
) => {
  const events: AnthropicEvent[] = [];
  return {
    state: { ...state, pendingFinishReason: finishReason },
    events,
  };
};

/**
 * Close any open content block and emit the terminal message_delta +
 * message_stop pair, carrying through the buffered finishReason and
 * the agent loop's final usage figures.
 */
export const processUsage = (
  state: AnthropicStreamState,
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  },
) => {
  const closed = closeCurrentBlock(state);
  const events: AnthropicEvent[] = [
    ...closed.events,
    buildMessageDelta(
      translateStopReason(closed.state.pendingFinishReason),
      usage.prompt_tokens,
      usage.completion_tokens,
    ),
    buildMessageStop(),
  ];
  return { state: closed.state, events };
};

// ---------------------------------------------------------------------------
// Streaming wrapper — bridges the agent loop's callbacks to the pure
// state machine and writes events to the outbound stream.
// ---------------------------------------------------------------------------

const generateMessageId = () => {
  const random = Math.random().toString(36).slice(2, 14);
  return `msg_${Date.now().toString(36)}${random}`;
};

const extractToolCalls = (delta: Record<string, unknown>) => {
  const raw = delta.tool_calls;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;

  const out: AnthropicToolCallDelta[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as {
      id?: string;
      function?: { name?: string; arguments?: string };
    };
    if (!e.id || !e.function?.name) continue;
    out.push({
      id: e.id,
      name: e.function.name,
      arguments: e.function.arguments ?? "",
    });
  }
  return out.length > 0 ? out : undefined;
};

export function anthropicStreamingResponse(model: Model, ctx: MimirContext) {
  const messageId = generateMessageId();
  const encoder = new TextEncoder();
  const modelId = ctx.request.model ?? "unknown";

  let state: AnthropicStreamState = initialAnthropicStreamState();

  const readable = new ReadableStream({
    start(controller) {
      // Emitters close over this response's controller — the loop never
      // sees it.
      const writeEvents = (events: AnthropicEvent[]) => {
        for (const e of events) {
          controller.enqueue(
            encoder.encode(
              `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`,
            ),
          );
        }
      };

      const emitSSE: EmitSSE = (delta, finishReason) => {
        if (typeof delta.content === "string" && delta.content.length > 0) {
          const step = processTextDelta(
            state,
            delta.content,
            modelId,
            messageId,
          );
          state = step.state;
          writeEvents(step.events);
        }
        if (
          typeof delta.reasoning_content === "string" &&
          delta.reasoning_content.length > 0
        ) {
          const step = processReasoningDelta(
            state,
            delta.reasoning_content,
            modelId,
            messageId,
          );
          state = step.state;
          writeEvents(step.events);
        }
        const toolCalls = extractToolCalls(delta);
        if (toolCalls) {
          const step = processToolCalls(state, toolCalls, modelId, messageId);
          state = step.state;
          writeEvents(step.events);
        }
        if (finishReason !== null && finishReason !== undefined) {
          const step = processFinish(state, finishReason);
          state = step.state;
          writeEvents(step.events);
        }
      };

      const emitUsage: EmitUsage = (usage) => {
        const step = processUsage(state, usage);
        state = step.state;
        writeEvents(step.events);
      };

      // Same contract as agent/run/response.ts: context assembly runs
      // inside the queued task so history snapshots serialize with the
      // in-flight turn.
      enqueueLlmCall(async () => {
        const options = await prepareTurn(ctx);
        return agentLoop(model, options, ctx, emitSSE, emitUsage);
      })
        .catch((err) => {
          log.error({ err }, "anthropic agent loop error");
          // Scrub the BYOK key before the message leaves on the stream —
          // provider SDK errors can echo request headers (MIM-73).
          const message = redactSecret(
            err instanceof Error ? err.message : String(err),
            ctx.providerOverride?.apiKey,
          );
          const errStep = processTextDelta(
            state,
            `\n\n[Error: ${message}]`,
            modelId,
            messageId,
          );
          state = errStep.state;
          writeEvents(errStep.events);

          const closeStep = processUsage(state, {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          });
          state = closeStep.state;
          writeEvents(closeStep.events);
        })
        .finally(async () => {
          controller.close();
          // Slice 5: close the request's scoped connection once the stream
          // has drained. No-op on the root connection.
          await closeScope(ctx.scope);
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
