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
  type SDKResultMessage,
  type SDKSystemMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { acpBlocksToAnthropicContent } from "../../agent/content";
import { errMessage } from "../../util";
import { createChildLogger, log } from "../../utils/log";
import type { BackendEvent } from "../types";
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
const stringifyToolResultContent = (content: unknown): string => {
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

/** Translate an SDKAssistantMessage into BackendEvent(s). */
function* translateAssistant(
  msg: SDKAssistantMessage,
): Generator<BackendEvent> {
  for (const block of msg.message.content ?? []) {
    if (block.type === "text") {
      yield { type: "text", text: block.text };
    } else if (block.type === "thinking") {
      yield {
        type: "thinking",
        text: (block as { thinking: string }).thinking,
      };
    } else if (block.type === "tool_use") {
      const tb = block as { id: string; name: string; input: unknown };
      yield {
        type: "tool_call",
        id: tb.id,
        name: tb.name,
        input: (tb.input ?? {}) as Record<string, unknown>,
        observeOnly: true,
      };
    }
  }
}

/** Translate an SDKUserMessage (tool results) into BackendEvent(s). */
function* translateUser(msg: SDKUserMessage): Generator<BackendEvent> {
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
        type: "tool_result",
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
): Generator<BackendEvent> {
  const usage = msg.usage;
  const promptTokens =
    (usage?.input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0);

  if (msg.subtype !== "success") {
    yield { type: "error", error: msg.errors.join("; ") };
  }

  yield {
    type: "finish",
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

export const runClaudeCode = async function* (
  options: RunClaudeCodeOptions,
): AsyncGenerator<BackendEvent> {
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

  const q = query({
    prompt: promptInput(),
    options: { ...buildSdkOptions(options), abortController },
  });
  activeQueries.add(q);

  const iter = q[Symbol.asyncIterator]();
  let sessionId: string | undefined;

  for (;;) {
    const next = await safeNext(iter);

    if (!next.ok) {
      if (!abortController.signal.aborted) {
        yield { type: "error", error: next.error };
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
        type: "init",
        sessionId: init.session_id,
        tools: init.tools ?? [],
      };
      continue;
    }

    // assistant message (complete turn)
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

    // All other message types (stream_event, compact_boundary, etc.) — skip
    logger.debug({ type: msg.type }, "ignoring SDK message");
  }

  activeQueries.delete(q);
  yield { type: "finish", sessionId };
};
