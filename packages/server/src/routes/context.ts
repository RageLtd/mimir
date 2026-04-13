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

import { Hono } from "hono";
import { runCompaction } from "../agent-loop/compaction";
import { updateTokenCount } from "../agent-loop/message-log/compaction-state";
import { retrieveMemories } from "../goldfish/memory";
import { getLastSummaries } from "../goldfish/store";
import { requestLog } from "../util/logger";

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
  } catch {
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
  } catch {
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
