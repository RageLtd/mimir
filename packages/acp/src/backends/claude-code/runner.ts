/**
 * Core Claude Code runner using the Agent SDK.
 *
 * Uses `query()` from @anthropic-ai/claude-agent-sdk to run Claude Code,
 * translates SDK message types to the normalized BackendEvent stream.
 * The SDK handles subprocess spawning, auth, and session management
 * internally — no temp files or NDJSON parsing needed.
 */

import {
  type Query,
  query,
  type SDKAssistantMessage,
  type SDKPartialAssistantMessage,
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { acpBlocksToAnthropicContent } from "../../agent/content";
import { errMessage } from "../../util";
import { createChildLogger, log } from "../../utils/log";
import { buildSdkOptions, type RunClaudeCodeOptions } from "./formatting";

const logger = createChildLogger(log, "cc-runner");

/**
 * Tracks active Query instances so they can be closed on process shutdown.
 * Per-request cancellation uses abortController (interrupts the current
 * turn); close() is reserved for agent termination.
 */
const activeQueries = new Set<Query>();

const shutdownAll = () => {
  for (const q of activeQueries) {
    q.close();
  }
  activeQueries.clear();
};

process.on("SIGTERM", shutdownAll);
process.on("SIGINT", shutdownAll);

/** Extract text from a tool_result content field. */
const stringifyToolResultContent = (content: unknown) => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object" && "text" in p) {
          return String((p as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
  }
  return "";
};

/**
 * Translate an SDKAssistantMessage into BackendEvent(s).
 *
 * With `includePartialMessages: true` the SDK streams text and thinking
 * deltas via `stream_event` messages (see translateStreamEvent). The
 * turn-final assistant message still arrives with the complete content
 * including those same text/thinking blocks — re-emitting them here would
 * double-render. Only tool_use blocks are yielded; they don't stream as
 * deltas at a useful granularity, so the turn-final form is where they
 * surface.
 */
function* translateAssistant(msg: SDKAssistantMessage) {
  for (const block of msg.message.content ?? []) {
    if (block.type === "tool_use") {
      const tb = block as { id: string; name: string; input: unknown };
      yield {
        type: "tool_call" as const,
        id: tb.id,
        name: tb.name,
        input: (tb.input ?? {}) as Record<string, unknown>,
        observeOnly: true,
      };
    }
  }
}

/**
 * Translate an SDKPartialAssistantMessage (stream_event) into BackendEvent(s).
 *
 * The inner `event` is an Anthropic `BetaRawMessageStreamEvent`. We emit
 * incremental text for `text_delta` and incremental thinking for
 * `thinking_delta`; everything else (message_start, content_block_start,
 * input_json_delta, message_delta, message_stop, ping) is ignored. Tool
 * input streaming via input_json_delta isn't worth the plumbing — the
 * tool-call UI renders on the complete turn-final block.
 */
function* translateStreamEvent(msg: SDKPartialAssistantMessage) {
  const event = msg.event as { type?: string; delta?: unknown };
  if (event.type !== "content_block_delta") return;
  const delta = event.delta as {
    type?: string;
    text?: string;
    thinking?: string;
  };
  if (delta.type === "text_delta" && typeof delta.text === "string") {
    yield { type: "text" as const, text: delta.text };
  } else if (
    delta.type === "thinking_delta" &&
    typeof delta.thinking === "string"
  ) {
    yield { type: "thinking" as const, text: delta.thinking };
  }
}

/** Translate an SDKUserMessage (tool results) into BackendEvent(s). */
function* translateUser(msg: SDKUserMessage) {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return;
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      "type" in part &&
      (part as { type: string }).type === "tool_result"
    ) {
      const tr = part as {
        tool_use_id: string;
        content: unknown;
      };
      yield {
        type: "tool_result" as const,
        id: tr.tool_use_id,
        output: stringifyToolResultContent(tr.content),
        observeOnly: true,
      };
    }
  }
}

/** Translate an SDKResultMessage into BackendEvent(s). */
function* translateResult(
  msg: SDKResultMessage,
  sessionId: string | undefined,
) {
  const usage = msg.usage;
  const promptTokens =
    (usage?.input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0);

  if (msg.subtype !== "success") {
    yield { type: "error" as const, error: msg.errors.join("; ") };
  }

  yield {
    type: "finish" as const,
    sessionId,
    stopReason: msg.subtype,
    promptTokens,
    completionTokens: usage?.output_tokens,
    cost: msg.total_cost_usd,
  };
}

/** Pull the next value from an async iterator, returning { ok, data/error }. */
type SafeOk<T> = { ok: true; data: IteratorResult<T> };
type SafeErr = { ok: false; error: string };

const safeNext = async <T>(
  iter: AsyncIterator<T>,
): Promise<SafeOk<T> | SafeErr> => {
  const result = await iter.next().catch(errMessage);
  if (typeof result === "string") return { ok: false, error: result };
  return { ok: true, data: result };
};

export const runClaudeCode = async function* (options: RunClaudeCodeOptions) {
  // Build the user message content parts. Use promptBlocks if available
  // (preserves images); fall back to plain text.
  const contentParts =
    options.promptBlocks && options.promptBlocks.length > 0
      ? acpBlocksToAnthropicContent(options.promptBlocks)
      : [{ type: "text" as const, text: options.prompt }];

  // Streaming input: yield a single user message then close the generator.
  async function* promptInput() {
    yield {
      type: "user" as const,
      message: { role: "user" as const, content: contentParts },
      parent_tool_use_id: null,
    };
  }

  // abortController interrupts the current turn without tearing down the session.
  // Full session cleanup happens only on agent shutdown via activeQueries.
  const abortController = new AbortController();
  if (options.signal) {
    options.signal.addEventListener("abort", () => abortController.abort(), {
      once: true,
    });
  }

  const sdkOptions = buildSdkOptions(options);

  const q = query({
    prompt: promptInput(),
    options: { ...sdkOptions, abortController },
  });
  activeQueries.add(q);

  const iter = q[Symbol.asyncIterator]();
  let sessionId: string | undefined;

  for (;;) {
    const next = await safeNext(iter);

    if (!next.ok) {
      if (!abortController.signal.aborted) {
        yield { type: "error" as const, error: next.error };
      }
      break;
    }

    if (next.data.done) break;
    const msg = next.data.value;

    // system:init
    if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
      const init = msg as SDKSystemMessage;
      sessionId = init.session_id;
      yield {
        type: "init" as const,
        sessionId: init.session_id,
        tools: init.tools ?? [],
      };
      continue;
    }

    // stream_event: partial assistant message (text/thinking deltas)
    if (msg.type === "stream_event") {
      yield* translateStreamEvent(msg as SDKPartialAssistantMessage);
      continue;
    }

    // assistant message (complete turn) — tool_use blocks only; text and
    // thinking have already been streamed via stream_event deltas.
    if (msg.type === "assistant") {
      const asst = msg as SDKAssistantMessage;
      sessionId = asst.session_id;
      yield* translateAssistant(asst);
      continue;
    }

    // user message (tool results from CC's internal loop)
    if (msg.type === "user" && !("isReplay" in msg)) {
      yield* translateUser(msg as SDKUserMessage);
      continue;
    }

    // result (final)
    if (msg.type === "result") {
      const result = msg as SDKResultMessage;
      sessionId = result.session_id;
      yield* translateResult(result, sessionId);
      activeQueries.delete(q);
      return;
    }

    // All other message types (compact_boundary, etc.) — skip
    logger.debug({ type: msg.type }, "ignoring SDK message");
  }

  activeQueries.delete(q);
  yield { type: "finish" as const, sessionId };
};
