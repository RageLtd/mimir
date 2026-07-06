/**
 * Context Routes
 *
 * Endpoints that mimir-acp calls to fetch context for the CC backend:
 *
 *   POST /v1/context/memories     — goldfish retrieval, formatted block
 *   GET  /v1/context/summaries    — last N conversation summaries
 *   POST /v1/context/token-report — token usage tracking; returns needsCompaction
 *   POST /v1/context/retrieve     — per-turn retrieval (memories + summaries)
 *                                   flattened to a single `<retrieved_context>`
 *                                   string for plugin injection into UserPromptSubmit
 *
 * Thin wrappers around the canonical internal functions so the CC backend
 * gets the same context the server backend's middleware pipeline produces.
 */

import { countTokens } from "gpt-tokenizer";
import { Hono } from "hono";
import { runCompaction } from "../agent/compaction";
import { getLastModelMessages } from "../agent/message-log";
import { updateTokenCount } from "../agent/message-log/compaction-state";
import { modelContentToString } from "../agent/message-log/message-utils";
import { config } from "../config";
import { retrieveContextBundle } from "../goldfish/context-bundle";
import { retrieveMemories } from "../goldfish/memory";
import { getLastSummaries } from "../goldfish/store";
import { buildContextInjection } from "../middleware/context-assembly";
import { scopeOrgId } from "../middleware/identity";
import { type ScopedEnv, scopeMiddleware } from "../middleware/scope";
import { requestLog } from "../util/logger";
import { attempt } from "../util/result";
import { loadPrompt } from "./system-prompt";

// Per-turn retrieval defaults — kept small so the injection budget stays
// modest. The full assemble path uses larger windows; retrieve is the
// per-prompt micro-injection.
const RETRIEVE_SUMMARY_COUNT = 3;
const RETRIEVE_MEMORY_TOP_K = 3;

export const context = new Hono<ScopedEnv>();

// ── Types ──

type MemoriesRequest = {
  query: string;
  project?: string;
};

type TokenReportRequest = {
  promptTokens: number;
  project?: string;
  /** Canonical project UUID. Logged only — compaction is global. */
  projectId?: string;
  modelId?: string;
};

// ── POST /v1/context/memories ──

context.post("/memories", scopeMiddleware, async (c) => {
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
    const memories = await retrieveMemories(c.get("scope"), [
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

context.get("/summaries", scopeMiddleware, async (c) => {
  const rid = c.req.header("x-request-id") ?? "summaries";
  const log = requestLog(rid);

  const countParam = c.req.query("count") ?? "3";
  const count = Math.max(1, Math.min(50, parseInt(countParam, 10) || 3));

  try {
    const summaries = await getLastSummaries(c.get("scope"), count);
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
      scopeOrgId(c),
      body.promptTokens,
      body.modelId,
    );

    // Mirror server backend post-processing: kick off async compaction
    // when the threshold is reached. Fire-and-forget.
    if (needsCompaction) {
      log.info(
        {
          project: body.project,
          projectId: body.projectId,
          modelId: body.modelId,
        },
        "token-report triggered async compaction",
      );
      runCompaction(scopeOrgId(c), body.modelId).catch((err) =>
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
  /**
   * Canonical project UUID from /v1/projects/resolve. Optional; the
   * assemble path is global (memories and summaries cross projects by
   * design), so this is logged for observability but not used for
   * scoping today. Reserved for per-project query endpoints in future.
   */
  projectId?: string;
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

context.post("/assemble", scopeMiddleware, async (c) => {
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

  const scope = c.get("scope");
  try {
    const [{ content: rawPrompt }, { memories, summaries, playbooks }] =
      await Promise.all([
        loadPrompt(),
        retrieveContextBundle(scope, body.query, {
          projectIdentifier: body.projectId ?? body.project,
        }),
      ]);

    const today = new Date().toISOString().split("T")[0] ?? "";
    const systemPrompt = rawPrompt.replace("{{DATE}}", today);

    // Mirror context-assembly middleware: last N raw messages, always.
    // Summaries are additive — they never replace raw recent history.
    const recentMessages = await getLastModelMessages(
      scope,
      config.context.keepRecentMessages,
    );

    // Build context injection pair — shared with server middleware.
    // Rules are null here — the CC backend gets them via boot tools, not this route.
    const injection = buildContextInjection(
      summaries,
      memories,
      null,
      playbooks,
    );

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
        projectId: body.projectId,
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

// ── POST /v1/context/retrieve ──
//
// Per-turn micro-retrieval for plugin UserPromptSubmit injection.
// Returns the formatted context block as a single string ready to inject
// as additionalContext, plus the counts so the caller can render a small
// "↻ Retrieved N memories / M summaries" status note.
//
// Reuses buildContextInjection so the format stays canonical with the
// middleware pipeline. The synthetic user/assistant pair returned by
// that helper is flattened to the user-side content and wrapped in
// <retrieved_context>...</retrieved_context>.

type RetrieveRequest = {
  query: string;
  project?: string;
  /** Canonical project UUID. Logged only — retrieval is global by design. */
  projectId?: string;
};

context.post("/retrieve", scopeMiddleware, async (c) => {
  const rid = c.req.header("x-request-id") ?? "retrieve";
  const log = requestLog(rid);

  const [bodyErr, body] = await attempt(() => c.req.json<RetrieveRequest>());
  if (bodyErr) {
    log.debug({ err: bodyErr.message }, "invalid JSON body");
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.query || typeof body.query !== "string") {
    return c.json({ error: "Missing required field: query" }, 400);
  }

  const scope = c.get("scope");
  const [retrievalErr, retrieval] = await attempt(() =>
    retrieveContextBundle(scope, body.query, {
      projectIdentifier: body.projectId ?? body.project,
      topK: RETRIEVE_MEMORY_TOP_K,
      includeRelated: false,
      summaryCount: RETRIEVE_SUMMARY_COUNT,
    }),
  );
  if (retrievalErr) {
    log.error({ err: retrievalErr.message }, "retrieve failed");
    return c.json({ error: retrievalErr.message }, 500);
  }

  const { memories, summaries, playbooks } = retrieval;
  const injection = buildContextInjection(summaries, memories, null, playbooks);
  // Count actual `- ` items, not raw newlines — memory bodies can span
  // multiple lines and would otherwise inflate the displayed count.
  const memoryCount = memories
    ? memories.split("\n").filter((l) => l.startsWith("- ")).length
    : 0;
  const summaryCount = summaries.length;

  // Empty injection → empty contextBlock; caller skips injection entirely.
  if (injection.length === 0) {
    log.debug(
      { project: body.project, projectId: body.projectId },
      "retrieve: no memories or summaries to inject",
    );
    return c.json({ contextBlock: "", memoryCount: 0, summaryCount: 0 });
  }

  // First entry is the synthetic user message — its content is the
  // already-formatted "Session context:\n<summaries>...<memories>..."
  // payload. Strip the "Session context:\n" preamble (it's redundant
  // inside our wrapper) and wrap in <retrieved_context>.
  const userMsg = injection[0];
  const rawContent =
    userMsg && typeof userMsg.content === "string" ? userMsg.content : "";
  const stripped = rawContent.replace(/^Session context:\s*/, "");
  const contextBlock = `<retrieved_context>\n${stripped}\n</retrieved_context>`;

  log.info(
    {
      project: body.project,
      projectId: body.projectId,
      summaryCount,
      memoryCount,
      blockChars: contextBlock.length,
    },
    "retrieve: returning context block",
  );

  return c.json({ contextBlock, memoryCount, summaryCount });
});
