/**
 * Core Claude Code runner using the Agent SDK in streaming-input mode.
 *
 * One Query is created at session start and reused across ACP prompts.
 * New user messages are pushed into a long-lived AsyncIterable that the
 * SDK drains; the subprocess and conversation state stay resident, so
 * subsequent turns don't re-spawn the CLI or replay the JSONL transcript.
 *
 * Per-turn cancellation is `q.interrupt()` (interrupts the current turn
 * but keeps the subprocess alive). `q.close()` is reserved for full
 * session teardown (compact, dispose).
 */

import type { ContentBlock } from "@agentclientprotocol/sdk";
import {
  type NonNullableUsage,
  type Query,
  query,
  type SDKAssistantMessage,
  type SDKPartialAssistantMessage,
  type SDKResultMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { acpBlocksToAnthropicContent } from "../../agent/content";
import { errMessage } from "../../util";
import { createChildLogger, log } from "../../utils/log";
import type { BackendEvent } from "../types";
import { buildSdkOptions, type RunClaudeCodeOptions } from "./formatting";

const logger = createChildLogger(log, "cc-runner");

/** Build the Anthropic content array for a single user message. */
const buildUserContent = (
  prompt: string,
  promptBlocks: readonly ContentBlock[] | undefined,
) =>
  promptBlocks && promptBlocks.length > 0
    ? acpBlocksToAnthropicContent(promptBlocks)
    : [{ type: "text" as const, text: prompt }];

/** Wrap content in the SDKUserMessage envelope the SDK expects. */
export const buildUserMessage = (
  prompt: string,
  promptBlocks: readonly ContentBlock[] | undefined,
) =>
  ({
    type: "user",
    message: {
      role: "user",
      content: buildUserContent(prompt, promptBlocks),
    },
    parent_tool_use_id: null,
  }) satisfies SDKUserMessage;

/**
 * An async iterable backed by an internal queue. `push` appends a value;
 * the iterable yields values FIFO and parks on a Promise when empty. `close`
 * ends the iteration after draining.
 *
 * The SDK's streaming-input mode reads from this iterable for the lifetime
 * of the Query — pushing a new SDKUserMessage triggers the next turn.
 */
export const createMessageQueue = () => {
  const queue: SDKUserMessage[] = [];
  let resolveNext: (() => void) | null = null;
  let closed = false;

  const wake = () => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  const push = (msg: SDKUserMessage) => {
    if (closed) {
      logger.warn("push on closed queue — message dropped");
      return;
    }
    queue.push(msg);
    wake();
  };

  const close = () => {
    closed = true;
    wake();
  };

  const iterable: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const head = queue.shift();
        if (head !== undefined) {
          yield head;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }
    },
  };

  return { iterable, push, close };
};

/**
 * Extract text from a tool_result content field. The Anthropic API allows
 * either a string or an array of content parts; for the array form we only
 * pull the `.text` from text parts and ignore image/document/etc. blocks
 * (their textual rendering is handled upstream).
 */
const stringifyToolResultContent = (content: unknown) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      if (typeof p === "string") return p;
      if (
        p &&
        typeof p === "object" &&
        "text" in p &&
        typeof p.text === "string"
      ) {
        return p.text;
      }
      return "";
    })
    .join("");
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
 *
 * `msg.error` (rate_limit, billing_error, max_output_tokens, …) is also
 * surfaced when present. Without this, a turn truncated by token limit
 * or bounced by the API looks identical to a clean turn until the
 * `result` message arrives — and rate_limit / billing_error don't always
 * map cleanly onto an SDKResultError subtype.
 */
function* translateAssistant(msg: SDKAssistantMessage) {
  if (msg.error) {
    yield {
      type: "error" as const,
      error: `assistant message error: ${msg.error}`,
    };
  }
  for (const block of msg.message.content ?? []) {
    if (block.type === "tool_use") {
      yield {
        type: "tool_call" as const,
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
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
  if (msg.event.type !== "content_block_delta") return;
  const delta = msg.event.delta;
  if (delta.type === "text_delta") {
    yield { type: "text" as const, text: delta.text };
  } else if (delta.type === "thinking_delta") {
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
      part.type === "tool_result"
    ) {
      yield {
        type: "tool_result" as const,
        id: part.tool_use_id,
        output: stringifyToolResultContent(part.content),
        observeOnly: true,
      };
    }
  }
}

/**
 * Pull the contextWindow advertised for the model the session selected.
 * `modelUsage` is a `Record<string, ModelUsage>` keyed by the SDK model
 * identifier — the same string we pass into `options.model`. Looking up
 * that exact key avoids the classic multi-model-turn lie: when an
 * auxiliary path inside the SDK fires on a different variant (a quick
 * `haiku` subagent burst, a `sonnet[1m]` internal step), we'd otherwise
 * advertise its window as the session ceiling and drive every
 * downstream decision (compaction trigger, UI gauge, headroom math) off
 * a number the user never opted into.
 */
const extractContextWindow = (
  modelUsage: SDKResultMessage["modelUsage"] | undefined,
  model: string | undefined,
) => {
  if (!modelUsage || !model) return undefined;
  return modelUsage[model]?.contextWindow;
};

/**
 * Compute the prompt-token count to surface as the conversation gauge.
 *
 * The top-level fields on `usage` (`input_tokens`, `cache_read_input_tokens`,
 * `cache_creation_input_tokens`) are documented as cumulative across every
 * sampling iteration in the turn — so a turn that fires N tool cycles reports
 * the sum of N API calls' inputs, not the size of the final context window.
 *
 * `usage.iterations[*]` carries per-iteration breakdowns. Per the SDK doc, the
 * last entry yields "the true context window size." We pick the last *message*
 * iteration (skipping compaction iterations, which describe a summarization
 * step and not the post-turn window) and sum its inputs. If the SDK gave us
 * no iteration breakdown, we fall back to the cumulative top-level.
 */
export const computeGaugePromptTokens = (
  usage: NonNullableUsage | undefined,
) => {
  const iterations = usage?.iterations;
  if (Array.isArray(iterations) && iterations.length > 0) {
    for (let i = iterations.length - 1; i >= 0; i--) {
      const it = iterations[i];
      if (it && it.type === "message") {
        return (
          it.input_tokens +
          it.cache_read_input_tokens +
          it.cache_creation_input_tokens
        );
      }
    }
  }
  return (
    (usage?.input_tokens ?? 0) +
    (usage?.cache_read_input_tokens ?? 0) +
    (usage?.cache_creation_input_tokens ?? 0)
  );
};

/**
 * Translate an SDKResultMessage into a single `finish` BackendEvent.
 *
 * One SDK result == one BackendEvent finish (the documented turn boundary).
 * Non-success outcomes carry their `errors[]` detail on the same event so
 * consumers can decide outcome (cancellation, refusal, success) at one
 * boundary instead of racing a separate error yield. Exported for unit
 * tests that assert this contract.
 */
export function* translateResult(
  msg: SDKResultMessage,
  sessionId: string | undefined,
  model: string | undefined,
) {
  const usage = msg.usage;
  const cumulativeInput = usage?.input_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheCreate = usage?.cache_creation_input_tokens ?? 0;
  const cumulativeTotal = cumulativeInput + cacheRead + cacheCreate;
  const promptTokens = computeGaugePromptTokens(usage);
  const contextWindow = extractContextWindow(msg.modelUsage, model);

  // Cache hit ratio is computed over the cumulative-across-iterations totals
  // because cache_read here is itself cumulative; comparing it to the
  // last-iteration gauge would mislabel churn. A low ratio after the first
  // turn points at churn somewhere in the prefix — system prompt, MCP tool
  // list, or boot tool results — and is the primary signal for diagnosing
  // why a turn cost more than expected.
  const cacheRatio =
    cumulativeTotal > 0
      ? Math.round((cacheRead / cumulativeTotal) * 100) / 100
      : 0;
  logger.info(
    {
      sessionId,
      stopReason: msg.subtype,
      uncachedTokens: cumulativeInput,
      cacheReadTokens: cacheRead,
      cacheCreateTokens: cacheCreate,
      cumulativeTotal,
      promptTokens,
      iterationCount: usage?.iterations?.length ?? 0,
      cacheRatio,
      outputTokens: usage?.output_tokens ?? 0,
      costUsd: msg.total_cost_usd,
      contextWindow,
    },
    "CC turn finished",
  );

  // One SDKResultMessage = one finish event (the SDK's documented turn
  // boundary). Non-success outcomes carry their detail on the same event
  // via `errors[]` so consumers decide outcome at the boundary instead of
  // racing a separate error yield. See prompt-cc.ts for the accumulator
  // pattern that handles both this and mid-turn `error` events uniformly.
  yield {
    type: "finish" as const,
    sessionId,
    stopReason: msg.subtype,
    promptTokens,
    completionTokens: usage?.output_tokens,
    cost: msg.total_cost_usd,
    ...(typeof contextWindow === "number" ? { contextWindow } : {}),
    ...(msg.subtype !== "success" ? { errors: msg.errors } : {}),
  };
}

/** Pull the next value from an async iterator, returning { ok, data/error }. */
type SafeOk<T> = { ok: true; data: IteratorResult<T> };
type SafeErr = { ok: false; error: string };

const safeNext = async <T>(iter: AsyncIterator<T>) => {
  const result = await iter.next().catch(errMessage);
  if (typeof result === "string") {
    logger.error({ error: result }, "CC SDK iter.next() threw");
    return { ok: false as const, error: result } satisfies SafeErr;
  }
  return { ok: true as const, data: result } satisfies SafeOk<T>;
};

export type CcSession = {
  readonly query: Query;
  readonly push: (msg: SDKUserMessage) => void;
  /**
   * Long-lived BackendEvent stream. Yields events as the SDK produces them
   * for every turn. A `finish` event marks a turn boundary; the generator
   * keeps running and waits for the next pushed user message. The generator
   * exits only when the underlying SDK iterator ends (Query closed) or errors.
   */
  readonly events: AsyncGenerator<BackendEvent>;
};

/**
 * Create a long-lived CC session. The first user message is pushed
 * immediately so the first turn fires. Subsequent turns are driven by
 * calling `push` with a new SDKUserMessage. Cancellation must go through
 * `query.interrupt()`; full teardown through `query.close()`.
 */
export const startClaudeCodeSession = (options: RunClaudeCodeOptions) => {
  const { iterable, push, close: closeQueue } = createMessageQueue();

  push(buildUserMessage(options.prompt, options.promptBlocks));

  const sdkOptions = buildSdkOptions(options);

  const q = query({
    prompt: iterable,
    options: sdkOptions,
  });

  const sp = sdkOptions.systemPrompt;
  const systemPromptChars = Array.isArray(sp)
    ? sp.reduce(
        (n, block) => n + (typeof block === "string" ? block.length : 0),
        0,
      )
    : typeof sp === "string"
      ? sp.length
      : 0;
  const systemPromptBlockCount = Array.isArray(sp) ? sp.length : 1;

  logger.info(
    {
      model: sdkOptions.model,
      cwd: sdkOptions.cwd,
      settingSources: sdkOptions.settingSources,
      skills: sdkOptions.skills,
      plugins: sdkOptions.plugins,
      disallowedToolCount: sdkOptions.disallowedTools?.length ?? 0,
      mcpServerCount: Object.keys(sdkOptions.mcpServers ?? {}).length,
      systemPromptChars,
      systemPromptBlockCount,
      includePartialMessages: sdkOptions.includePartialMessages,
    },
    "CC SDK query() created (streaming input), starting iteration",
  );

  const events = (async function* () {
    const iter = q[Symbol.asyncIterator]();
    let sessionId: string | undefined;

    for (;;) {
      const next = await safeNext(iter);

      if (!next.ok) {
        logger.error({ error: next.error }, "CC SDK iterator error");
        yield { type: "error" as const, error: next.error };
        break;
      }

      if (next.data.done) {
        logger.info({ sessionId }, "CC SDK iterator completed (done=true)");
        break;
      }
      const msg = next.data.value;

      if (msg.type === "system" && msg.subtype === "init") {
        sessionId = msg.session_id;
        logger.info(
          {
            sessionId: msg.session_id,
            claudeCodeVersion: msg.claude_code_version,
            model: msg.model,
            permissionMode: msg.permissionMode,
            tools: msg.tools ?? [],
            toolCount: (msg.tools ?? []).length,
            mcpServers: (msg.mcp_servers ?? []).map((s) => ({
              name: s.name,
              status: s.status,
            })),
            slashCommandCount: (msg.slash_commands ?? []).length,
            skills: msg.skills ?? [],
            skillCount: (msg.skills ?? []).length,
            plugins: (msg.plugins ?? []).map((p) => p.name),
            pluginCount: (msg.plugins ?? []).length,
          },
          "CC SDK init",
        );
        yield {
          type: "init" as const,
          sessionId: msg.session_id,
          tools: msg.tools ?? [],
        };
        continue;
      }

      if (msg.type === "stream_event") {
        yield* translateStreamEvent(msg);
        continue;
      }

      if (msg.type === "assistant") {
        sessionId = msg.session_id;
        yield* translateAssistant(msg);
        continue;
      }

      if (msg.type === "user" && !("isReplay" in msg)) {
        yield* translateUser(msg);
        continue;
      }

      // result is a turn boundary — yield finish but DO NOT exit the
      // generator. The SDK continues to wait on the streaming input
      // iterable for the next user message.
      if (msg.type === "result") {
        sessionId = msg.session_id;
        yield* translateResult(msg, sessionId, sdkOptions.model);
        continue;
      }

      logger.info({ type: msg.type, sessionId }, "ignoring SDK message");
    }

    closeQueue();
  })();

  return { query: q, push, events };
};

/** Push a new user message into an existing CC session. */
export const feedClaudeCodeMessage = (
  push: (msg: SDKUserMessage) => void,
  prompt: string,
  promptBlocks: readonly ContentBlock[] | undefined,
) => {
  push(buildUserMessage(prompt, promptBlocks));
};
