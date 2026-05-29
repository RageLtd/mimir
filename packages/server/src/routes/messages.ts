/**
 * Conversation Persistence Endpoint
 *
 * POST /v1/messages/persist
 *
 * Receives the trailing turn delta from the CC backend — CC runs inference
 * locally via the Claude Agent SDK and ships the last-N of its local
 * message history per turn (`session.messages.slice(-2)` as of writing).
 * The delta is already chosen client-side, so the server just appends it
 * to the global log with retry idempotency.
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
import { appendTurn } from "../agent-loop/message-log/persistence";
import { extractMemoriesFromResponse } from "../agent-loop/post-processing";
import { requestLog } from "../util/logger";
import { attempt } from "../util/result";

export const messages = new Hono();

type PersistRequest = {
  messages: ModelMessage[];
  /** Legacy cwd-style path. Always required for back-compat. */
  project: string;
  /**
   * Canonical project UUID from /v1/projects/resolve. Optional during the
   * transition window — Slice-1 plugins send only `project`, Slice-2-aware
   * plugins send both. When present, stored alongside `project` on the
   * message_log row for future UUID-keyed queries.
   */
  projectId?: string;
  /** Optional cost report from the CC backend (USD for the turn). */
  totalCostUsd?: number;
};

messages.post("/persist", async (c) => {
  const rid = c.req.header("x-request-id") ?? "persist";
  const log = requestLog(rid);

  let body: PersistRequest;
  try {
    body = await c.req.json();
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      "invalid JSON body",
    );
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return c.json({ error: "Missing or empty messages array" }, 400);
  }

  if (!body.project || typeof body.project !== "string") {
    return c.json({ error: "Missing required field: project" }, 400);
  }

  const projectId =
    typeof body.projectId === "string" && body.projectId.length > 0
      ? body.projectId
      : null;

  const [appendErr, ids] = await attempt(() =>
    appendTurn(body.messages, body.project, projectId),
  );
  if (appendErr) {
    log.error(
      { error: appendErr.message, project: body.project, projectId },
      "conversation persist failed",
    );
    return c.json({ error: appendErr.message }, 500);
  }

  if (typeof body.totalCostUsd === "number" && body.totalCostUsd > 0) {
    log.info(
      {
        project: body.project,
        projectId,
        totalCostUsd: body.totalCostUsd,
      },
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
      projectId,
      clientCount: body.messages.length,
      appended: ids.length,
    },
    "conversation persisted",
  );
  return c.json({ appended: ids.length, ids });
});
