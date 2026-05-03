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

/** Translate an SDKResultMessage into BackendEvent(s). */
function* translateResult(
  msg: SDKResultMessage,
  sessionId: string | undefined,
  model: string | undefined,
) {
  const usage = msg.usage;
  const inputTokens = usage?.input_tokens ?? 0;
  const cacheRead = usage?.cache_read_input_tokens ?? 0;
  const cacheCreate = usage?.cache_creation_input_tokens ?? 0;
  const promptTokens = inputTokens + cacheRead + cacheCreate;
  const contextWindow = extractContextWindow(msg.modelUsage, model);

  // Cache hit ratio over total prompt input. A low ratio after the first turn
  // points at churn somewhere in the prefix — system prompt, MCP tool list,
  // or boot tool results — and is the primary signal for diagnosing why a
  // turn cost more than expected.
  const cacheRatio =
    promptTokens > 0 ? Math.round((cacheRead / promptTokens) * 100) / 100 : 0;
  logger.info(
    {
      sessionId,
      stopReason: msg.subtype,
      uncachedTokens: inputTokens,
      cacheReadTokens: cacheRead,
      cacheCreateTokens: cacheCreate,
      promptTokens,
      cacheRatio,
      outputTokens: usage?.output_tokens ?? 0,
      costUsd: msg.total_cost_usd,
      contextWindow,
    },
    "CC turn finished",
  );

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
    ...(typeof contextWindow === "number" ? { contextWindow } : {}),
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

  // systemPrompt is either a single string or an array of blocks (with the
  // SYSTEM_PROMPT_DYNAMIC_BOUNDARY sentinel separating the cacheable prefix
  // from the dynamic suffix). Sum char counts so the log line is meaningful
  // either way.
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
      persistSession: sdkOptions.persistSession,
      settingSources: sdkOptions.settingSources,
      skills: sdkOptions.skills,
      plugins: sdkOptions.plugins,
      disallowedToolCount: sdkOptions.disallowedTools?.length ?? 0,
      mcpServerCount: Object.keys(sdkOptions.mcpServers ?? {}).length,
      systemPromptChars,
      systemPromptBlockCount,
      includePartialMessages: sdkOptions.includePartialMessages,
    },
    "CC SDK query() created, starting iteration",
  );

  const iter = q[Symbol.asyncIterator]();
  let sessionId: string | undefined;

  for (;;) {
    const next = await safeNext(iter);

    if (!next.ok) {
      if (!abortController.signal.aborted) {
        logger.error(
          { error: next.error },
          "CC SDK iterator error (not aborted)",
        );
        yield { type: "error" as const, error: next.error };
      } else {
        logger.info("CC SDK iterator error after abort — expected");
      }
      break;
    }

    if (next.data.done) {
      logger.info({ sessionId }, "CC SDK iterator completed (done=true)");
      break;
    }
    const msg = next.data.value;

    // system:init
    if (msg.type === "system" && msg.subtype === "init") {
      sessionId = msg.session_id;
      // Log what the SDK actually loaded for this turn. The init message is
      // the only place where tool/skill/plugin/slash-command counts surface;
      // capturing them lets us spot when settings (skills:[], plugins:[],
      // disallowedTools) aren't taking effect — e.g. a fresh CC release that
      // ignores one of them and re-introduces ten extra skills.
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

    // stream_event: partial assistant message (text/thinking deltas)
    if (msg.type === "stream_event") {
      yield* translateStreamEvent(msg);
      continue;
    }

    // assistant message (complete turn) — tool_use blocks only; text and
    // thinking have already been streamed via stream_event deltas.
    if (msg.type === "assistant") {
      sessionId = msg.session_id;
      yield* translateAssistant(msg);
      continue;
    }

    // user message (tool results from CC's internal loop)
    if (msg.type === "user" && !("isReplay" in msg)) {
      yield* translateUser(msg);
      continue;
    }

    // result (final)
    if (msg.type === "result") {
      sessionId = msg.session_id;
      yield* translateResult(msg, sessionId, sdkOptions.model);
      activeQueries.delete(q);
      return;
    }

    // All other message types — log at info so they're visible in
    // acp.log by default.
    logger.info({ type: msg.type, sessionId }, "ignoring SDK message");
  }

  logger.info({ sessionId }, "CC SDK loop ended — yielding finish");
  activeQueries.delete(q);
  yield { type: "finish" as const, sessionId };
};
