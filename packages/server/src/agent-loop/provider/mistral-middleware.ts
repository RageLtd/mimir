/**
 * Mistral Tool Call Streaming Middleware
 *
 * vLLM's `--tool-call-parser mistral` correctly intercepts [TOOL_CALLS] in
 * non-streaming mode, but in streaming mode the parser is broken — tool calls
 * arrive as raw text deltas instead of structured tool_calls chunks.
 *
 * This middleware sits at the AI SDK model layer (via wrapLanguageModel) and
 * intercepts the text stream, detecting Mistral's native [TOOL_CALLS] format
 * and converting it into proper tool-call stream parts.
 *
 * Format: [TOOL_CALLS]tool_name{"arg": "value"}[TOOL_CALLS]tool_name{"arg": "value"}
 *
 * V5/V6 provider stream parts for tool calls:
 *   tool-input-start  → { type, id, toolName }
 *   tool-input-delta  → { type, id, delta }
 *   tool-input-end    → { type, id }
 *   tool-call         → { type, toolCallId, toolName, input }
 */
import type {
  LanguageModelV3Middleware,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { generateId } from "ai";
import { log } from "../../util/logger";

const TOOL_CALL_MARKER = "[TOOL_CALLS]";

/**
 * Parse all complete tool calls from a buffer string.
 * Returns parsed calls and any remaining unparsed content.
 */
function parseToolCalls(input: string): {
  calls: Array<{ name: string; args: string }>;
  remaining: string;
} {
  const calls: Array<{ name: string; args: string }> = [];
  let rest = input;

  while (rest.length > 0) {
    const nameMatch = rest.match(/^(\w+)\s*\{/);
    if (!nameMatch) break;

    const name = nameMatch[1];
    const jsonStart = rest.indexOf("{", name?.length);

    let depth = 0;
    let end = -1;
    for (let i = jsonStart; i < rest.length; i++) {
      if (rest[i] === "{") depth++;
      else if (rest[i] === "}") {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (end === -1) break;

    const argsJson = rest.slice(jsonStart, end + 1);
    calls.push({ name: name ?? "", args: argsJson });
    rest = rest.slice(end + 1);
  }

  return { calls, remaining: rest };
}

/** Emit a complete tool call as proper V5/V6 stream parts */
function emitToolCall(
  controller: TransformStreamDefaultController<LanguageModelV3StreamPart>,
  toolName: string,
  argsJson: string,
): void {
  const id = generateId();

  // tool-input-start → tool-input-delta → tool-input-end → tool-call
  controller.enqueue({
    type: "tool-input-start",
    id,
    toolName,
  } as LanguageModelV3StreamPart);

  controller.enqueue({
    type: "tool-input-delta",
    id,
    delta: argsJson,
  } as LanguageModelV3StreamPart);

  controller.enqueue({
    type: "tool-input-end",
    id,
  } as LanguageModelV3StreamPart);

  controller.enqueue({
    type: "tool-call",
    toolCallId: id,
    toolName,
    input: argsJson,
  } as LanguageModelV3StreamPart);

  log.debug(
    { toolName, args: argsJson.slice(0, 80) },
    "mistral middleware: parsed tool call from stream",
  );
}

export const mistralToolCallMiddleware: LanguageModelV3Middleware = {
  specificationVersion: "v3",

  wrapStream: async ({ doStream }) => {
    const { stream, ...rest } = await doStream();

    let buffer = "";
    let intercepting = false;
    let hasToolCalls = false;
    let activeTextId: string | null = null;

    const transform = new TransformStream<
      LanguageModelV3StreamPart,
      LanguageModelV3StreamPart
    >({
      transform(chunk, controller) {
        // Track text block IDs
        if (chunk.type === "text-start") {
          activeTextId = chunk.id;
          controller.enqueue(chunk);
          return;
        }

        // Suppress text-end if we converted all content to tool calls
        if (chunk.type === "text-end") {
          if (!hasToolCalls) {
            controller.enqueue(chunk);
          }
          return;
        }

        // Override finish reason if we found tool calls
        if (chunk.type === "finish") {
          if (hasToolCalls) {
            controller.enqueue({ ...chunk, finishReason: chunk.finishReason });
          } else {
            controller.enqueue(chunk);
          }
          return;
        }

        // Only intercept text-delta parts
        if (chunk.type !== "text-delta") {
          controller.enqueue(chunk);
          return;
        }

        // V5/V6 provider spec: { type: "text-delta", id, delta }
        const textContent = chunk.delta;
        if (!textContent) return;

        buffer += textContent;

        const markerIdx = buffer.indexOf(TOOL_CALL_MARKER);

        if (markerIdx === -1 && !intercepting) {
          const holdBack = couldBePartialMarker(buffer);
          if (holdBack < buffer.length) {
            const safe = buffer.slice(0, buffer.length - holdBack);
            if (safe) {
              controller.enqueue({
                type: "text-delta",
                id: activeTextId ?? generateId(),
                delta: safe,
              } as LanguageModelV3StreamPart);
            }
            buffer = buffer.slice(buffer.length - holdBack);
          }
          return;
        }

        if (markerIdx >= 0) {
          if (markerIdx > 0) {
            controller.enqueue({
              type: "text-delta",
              id: activeTextId ?? generateId(),
              delta: buffer.slice(0, markerIdx),
            } as LanguageModelV3StreamPart);
          }
          buffer = buffer.slice(markerIdx + TOOL_CALL_MARKER.length);
          intercepting = true;
          hasToolCalls = true;
        }

        if (!intercepting) return;

        // Parse tool calls from buffered content
        while (true) {
          const nextMarker = buffer.indexOf(TOOL_CALL_MARKER);
          const segment =
            nextMarker >= 0 ? buffer.slice(0, nextMarker) : buffer;

          const { calls, remaining } = parseToolCalls(segment);

          for (const call of calls) {
            emitToolCall(controller, call.name, call.args);
          }

          if (nextMarker >= 0) {
            buffer = buffer.slice(nextMarker + TOOL_CALL_MARKER.length);
            continue;
          }

          buffer = remaining;
          break;
        }
      },

      flush(controller) {
        if (buffer.length > 0 && !intercepting) {
          controller.enqueue({
            type: "text-delta",
            id: activeTextId ?? generateId(),
            delta: buffer,
          } as LanguageModelV3StreamPart);
        }
      },
    });

    return {
      stream: stream.pipeThrough(transform),
      ...rest,
    };
  },
};

/**
 * How many trailing characters of `text` could be the start of [TOOL_CALLS]?
 */
function couldBePartialMarker(text: string): number {
  for (
    let len = Math.min(text.length, TOOL_CALL_MARKER.length - 1);
    len > 0;
    len--
  ) {
    if (text.endsWith(TOOL_CALL_MARKER.slice(0, len))) {
      return len;
    }
  }
  return 0;
}
