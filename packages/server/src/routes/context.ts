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
import {
  getModelMessagesSince,
  getRecentModelMessages,
} from "../agent-loop/message-log";
import { updateTokenCount } from "../agent-loop/message-log/compaction-state";
import { modelContentToString } from "../agent-loop/message-log/message-utils";
import { config } from "../config";
import { retrieveMemories } from "../goldfish/memory";
import { getLastSummaries } from "../goldfish/store";
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

    // Mirror context-assembly middleware: messages since last summary,
    // or full history when no summaries exist yet.
    let recentMessages: Awaited<ReturnType<typeof getRecentModelMessages>>;
    if (summaries.length > 0 && summaries[0]?.created_at) {
      recentMessages = await getModelMessagesSince(
        new Date(summaries[0].created_at),
      );
      if (recentMessages.length > config.context.keepRecentMessages) {
        recentMessages = recentMessages.slice(
          -config.context.keepRecentMessages,
        );
      }
    } else {
      recentMessages = await getRecentModelMessages();
    }

    // Build context injection pair
    const contextParts: string[] = [];
    if (summaries.length > 0) {
      const summaryText = summaries
        .map((s, i) => `[Summary ${i + 1}]\n${s.content}`)
        .join("\n\n");
      contextParts.push(`<summaries>\n${summaryText}\n</summaries>`);
    }
    if (memories) {
      contextParts.push(`<memories>\n${memories}\n</memories>`);
    }

    const messages: SimpleMessage[] = [];

    if (contextParts.length > 0) {
      messages.push({
        role: "user",
        content: `Session context:\n${contextParts.join("\n\n")}`,
      });
      messages.push({ role: "assistant", content: "Understood." });
    }

    // Flatten historical turns to text (tool calls/results included as prose)
    for (const msg of recentMessages) {
      if (msg.role !== "user" && msg.role !== "assistant") continue;
      const content = modelContentToString(msg.content);
      if (!content) continue;
      messages.push({ role: msg.role, content });
    }

    // Current user message is the final entry
    messages.push({ role: "user", content: body.query });

    log.info(
      {
        project: body.project,
        summaries: summaries.length,
        recentMessages: recentMessages.length,
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
