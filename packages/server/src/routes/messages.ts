/**
 * Conversation Persistence Endpoint
 *
 * POST /v1/messages/persist
 *
 * Receives conversation turns from mimir-acp (CC backend) and persists
 * them to the global message log via the canonical appendNewMessages()
 * sequence-matching dedup path. Keeps goldfish, compaction, and memory
 * extraction working when inference happens via Claude Code.
 *
 * Body:
 *   { messages: ModelMessage[], project: string }
 *
 * Response:
 *   { appended: number, ids: (string | null)[] }
 */

import type { ModelMessage } from "@ai-sdk/provider-utils";
import { Hono } from "hono";
import { modelContentToString } from "../agent-loop/message-log/message-utils";
import { appendNewMessages } from "../agent-loop/message-log/persistence";
import { extractMemoriesFromResponse } from "../agent-loop/post-processing";
import { requestLog } from "../util/logger";

export const messages = new Hono();

type PersistRequest = {
  messages: ModelMessage[];
  project: string;
  /** Optional cost report from the CC backend (USD for the turn). */
  totalCostUsd?: number;
};

messages.post("/persist", async (c) => {
  const rid = c.req.header("x-request-id") ?? "persist";
  const log = requestLog(rid);

  let body: PersistRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: "Missing or empty messages array" }, 400);
  }

  if (!body.project || typeof body.project !== "string") {
    return c.json({ error: "Missing required field: project" }, 400);
  }

  try {
    const ids = await appendNewMessages(body.messages, body.project);

    if (typeof body.totalCostUsd === "number" && body.totalCostUsd > 0) {
      log.info(
        { project: body.project, totalCostUsd: body.totalCostUsd },
        "cc turn cost",
      );
    }

    // Mirror server-backend post-processing: kick off async memory
    // extraction from the latest user/assistant exchange. Fire-and-forget;
    // never blocks the response.
    if (ids.length > 0) {
      const lastAssistant = [...body.messages]
        .reverse()
        .find((m) => m.role === "assistant");
      const lastUser = [...body.messages]
        .reverse()
        .find((m) => m.role === "user");
      if (lastAssistant && lastUser) {
        const assistantText = modelContentToString(lastAssistant.content);
        if (assistantText) {
          extractMemoriesFromResponse(assistantText, lastUser, body.project);
        }
      }
    }

    log.info(
      {
        project: body.project,
        clientCount: body.messages.length,
        appended: ids.length,
      },
      "conversation persisted",
    );
    return c.json({ appended: ids.length, ids });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(
      { error: msg, project: body.project },
      "conversation persist failed",
    );
    return c.json({ error: msg }, 500);
  }
});
