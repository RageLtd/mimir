/**
 * Context Routes
 *
 * Endpoints that mimir-acp calls to fetch context for the CC backend:
 *
 *   POST /v1/context/memories     — goldfish retrieval, formatted block
 *   GET  /v1/context/summaries    — last N conversation summaries
 *   POST /v1/context/token-report — token usage tracking; returns needsCompaction
 *
 * Thin wrappers around the canonical internal functions so the CC backend
 * gets the same context the server backend's middleware pipeline produces.
 */

import { countTokens } from "gpt-tokenizer";
import { Hono } from "hono";
import { runCompaction } from "../agent-loop/compaction";
import { getLastNModelMessages } from "../agent-loop/message-log";
import { updateTokenCount } from "../agent-loop/message-log/compaction-state";
import { modelContentToString } from "../agent-loop/message-log/message-utils";
import { config } from "../config";
import { retrieveMemories } from "../goldfish/memory";
import { getLastSummaries } from "../goldfish/store";
import { buildContextInjection } from "../middleware/context-assembly";
import { requestLog } from "../util/logger";
import { loadPrompt } from "./system-prompt";

export const context = new Hono();

// ── Types ──

type MemoriesRequest = {
  query: string;
  project?: string;
};

type TokenReportRequest = {
  promptTokens: number;
  project?: string;
  modelId?: string;
};

// ── POST /v1/context/memories ──

context.post("/memories", async (c) => {
  const rid = c.req.header("x-request-id") ?? "mem";
  const log = requestLog(rid);

  let body: MemoriesRequest;
  try {
    body = await c.req.json();
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "invalid JSON body",
    );
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.query || typeof body.query !== "string") {
    return c.json({ error: "Missing required field: query" }, 400);
  }

  try {
    // retrieveMemories takes ModelMessage[] and reads the last 3 user
    // messages to build its query. Synthesize a single user message from
    // the caller's query string so we share one code path.
    const memories = await retrieveMemories([
      { role: "user", content: body.query },
    ]);

    log.debug(
      { queryChars: body.query.length, hasMemories: memories !== null },
      "memories retrieved",
    );

    return c.json({ memories });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg }, "memory retrieval failed");
    return c.json({ error: msg }, 500);
  }
});

// ── GET /v1/context/summaries ──

context.get("/summaries", async (c) => {
  const rid = c.req.header("x-request-id") ?? "summaries";
  const log = requestLog(rid);

  const countParam = c.req.query("count") ?? "3";
  const count = Math.max(1, Math.min(50, parseInt(countParam, 10) || 3));

  try {
    const summaries = await getLastSummaries(count);
    log.debug({ count: summaries.length }, "summaries retrieved");
    return c.json({ summaries });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg }, "summaries retrieval failed");
    return c.json({ error: msg }, 500);
  }
});

// ── POST /v1/context/token-report ──

context.post("/token-report", async (c) => {
  const rid = c.req.header("x-request-id") ?? "tokens";
  const log = requestLog(rid);

  let body: TokenReportRequest;
  try {
    body = await c.req.json();
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "invalid JSON body",
    );
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body.promptTokens !== "number" || body.promptTokens < 0) {
    return c.json(
      { error: "Missing required field: promptTokens (number)" },
      400,
    );
  }

  try {
    const { needsCompaction } = await updateTokenCount(
      body.promptTokens,
      body.modelId,
    );

    // Mirror server backend post-processing: kick off async compaction
    // when the threshold is reached. Fire-and-forget.
    if (needsCompaction) {
      log.info(
        { project: body.project, modelId: body.modelId },
        "token-report triggered async compaction",
      );
      runCompaction(body.modelId).catch((err) =>
        log.error({ err }, "compaction failed"),
      );
    }

    return c.json({ needsCompaction });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg }, "token report failed");
    return c.json({ error: msg }, 500);
  }
});

// ── POST /v1/context/assemble ──
//
// Single-call context assembly for the CC backend.
// Returns the system prompt + full message array (context injection pair,
// historical turns from DB, and the current user message) ready to pipe
// to `claude --input-format stream-json`.

type AssembleRequest = {
  query: string;
  project?: string;
};

type SimpleMessage = { role: "user" | "assistant"; content: string };

/**
 * Trim a chronological list of rendered messages to fit within a token
 * budget, walking newest-first and reversing back to chronological order.
 *
 * Uses gpt-tokenizer's cl100k_base BPE encoding as a rough proxy for
 * Anthropic's tokenizer — slight overcount is intentional. The most recent
 * message is always kept, even if it alone exceeds the budget; otherwise we
 * could ship an empty history when one giant tool result lands at the tail.
 *
 * Budget ≤ 0 disables trimming.
 */
export function trimByTokenBudget(
  rendered: SimpleMessage[],
  tokenBudget: number,
) {
  if (tokenBudget <= 0 || rendered.length === 0) {
    return { kept: rendered, tokensUsed: 0, dropped: 0 };
  }

  const kept: SimpleMessage[] = [];
  let used = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const m = rendered[i];
    const cost = countTokens(m?.content ?? "");
    if (used + cost > tokenBudget && kept.length > 0) break;
    kept.unshift(m as SimpleMessage);
    used += cost;
  }
  return {
    kept,
    tokensUsed: used,
    dropped: rendered.length - kept.length,
  };
}

context.post("/assemble", async (c) => {
  const rid = c.req.header("x-request-id") ?? "assemble";
  const log = requestLog(rid);

  let body: AssembleRequest;
  try {
    body = await c.req.json();
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "invalid JSON body",
    );
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.query || typeof body.query !== "string") {
    return c.json({ error: "Missing required field: query" }, 400);
  }

  try {
    const [{ content: rawPrompt }, memories, summaries] = await Promise.all([
      loadPrompt(),
      retrieveMemories([{ role: "user", content: body.query }]),
      getLastSummaries(3),
    ]);

    const today = new Date().toISOString().split("T")[0] ?? "";
    const systemPrompt = rawPrompt.replace("{{DATE}}", today);

    // Mirror context-assembly middleware: last N raw messages, always.
    // Summaries are additive — they never replace raw recent history.
    const recentMessages = await getLastNModelMessages(
      config.context.keepRecentMessages,
    );

    // Build context injection pair — shared with server middleware.
    // Rules are null here — the CC backend gets them via boot tools, not this route.
    const injection = buildContextInjection(summaries, memories, null);

    const messages: SimpleMessage[] = injection.map((m) => ({
      role: m.role as "user" | "assistant",
      content: typeof m.content === "string" ? m.content : "",
    }));

    // Flatten historical turns to text (tool calls/results included as prose),
    // then trim newest-first to fit `assemblyTokenBudget`. The DB pull is
    // already capped at `keepRecentMessages` (default 50); this is the second
    // fence — keep the bytes that go into the model bounded even when a
    // handful of giant tool results land in the recent window.
    const renderedHistory: SimpleMessage[] = recentMessages.flatMap((msg) => {
      if (msg.role !== "user" && msg.role !== "assistant") return [];
      const content = modelContentToString(msg.content);
      if (!content) return [];
      return [{ role: msg.role, content }];
    });

    const { kept, tokensUsed, dropped } = trimByTokenBudget(
      renderedHistory,
      config.context.assemblyTokenBudget,
    );

    messages.push(...kept);

    // Current user message is the final entry
    messages.push({ role: "user", content: body.query });

    log.info(
      {
        project: body.project,
        summaries: summaries.length,
        recentMessages: recentMessages.length,
        renderedHistory: renderedHistory.length,
        keptHistory: kept.length,
        droppedHistory: dropped,
        historyTokens: tokensUsed,
        hasMemories: !!memories,
        totalMessages: messages.length,
      },
      "context assembled for CC",
    );

    return c.json({ systemPrompt, messages });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg }, "context assembly failed");
    return c.json({ error: msg }, 500);
  }
});
