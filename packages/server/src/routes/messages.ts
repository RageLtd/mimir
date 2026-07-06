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
 *   { messages: ModelMessage[], projectId?: string, project?: string }
 *
 * Response:
 *   { appended: number, ids: (string | null)[] }
 */

import type { ModelMessage } from "@ai-sdk/provider-utils";
import { Hono } from "hono";
import { modelContentToString } from "../agent/message-log/message-utils";
import { appendTurn } from "../agent/message-log/persistence";
import { extractMemoriesFromResponse } from "../agent/post-processing";
import { OWNER_ORG_SENTINEL } from "../db/scope";
import {
  extractProviderOverride,
  PROVIDER_KEY_HEADER,
} from "../middleware/pipeline";
import { ensureProjectId } from "../projects/store";
import { requestLog } from "../util/logger";
import { attempt } from "../util/result";

export const messages = new Hono();

type PersistRequest = {
  messages: ModelMessage[];
  /**
   * Canonical project ULID from /v1/projects/resolve. Preferred; wins
   * over `project` when both are present.
   */
  projectId?: string;
  /**
   * Any project identifier — cwd-style path or id. Resolved (get-or-create
   * for unknown paths) at this boundary; storage keys exclusively on the
   * canonical id.
   */
  project?: string;
  /** Optional cost report from the CC backend (USD for the turn). */
  totalCostUsd?: number;
  /** BYOK (MIM-74): provider id for the extraction this persist spawns.
   * Pairs with the X-Provider-Api-Key header — the key itself never
   * rides the body (bodies get logged on failure; headers don't). */
  provider?: string;
  /** BYOK (MIM-74): small/cheap model for the spawned extraction. Persist
   * POSTs carry no request model, so without this the extraction falls
   * back to the env-configured small model. */
  small_model?: string;
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

  const identifier =
    (typeof body.projectId === "string" && body.projectId.length > 0
      ? body.projectId
      : null) ??
    (typeof body.project === "string" && body.project.length > 0
      ? body.project
      : null);
  if (!identifier) {
    return c.json(
      { error: "Missing required field: projectId (or project)" },
      400,
    );
  }

  const projectId = await ensureProjectId(identifier);
  if (!projectId) {
    log.error({ identifier }, "failed to resolve project identifier");
    return c.json(
      { error: `Failed to resolve project identifier "${identifier}"` },
      500,
    );
  }

  const [appendErr, ids] = await attempt(() =>
    appendTurn(body.messages, projectId),
  );
  if (appendErr) {
    log.error(
      { error: appendErr.message, projectId },
      "conversation persist failed",
    );
    return c.json({ error: appendErr.message }, 500);
  }

  if (typeof body.totalCostUsd === "number" && body.totalCostUsd > 0) {
    log.info(
      {
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
        // BYOK (MIM-74): same key transport as the ingress routes — the
        // extraction this persist spawns runs on the caller's key when
        // one was sent, the env small model otherwise.
        const override = extractProviderOverride(
          c.req.header(PROVIDER_KEY_HEADER),
          { provider: body.provider, small_model: body.small_model },
        );
        extractMemoriesFromResponse(
          assistantText,
          lastUser,
          projectId,
          OWNER_ORG_SENTINEL,
          override ? { override } : null,
        );
      }
    }
  }

  log.info(
    {
      projectId,
      clientCount: body.messages.length,
      appended: ids.length,
    },
    "conversation persisted",
  );
  return c.json({ appended: ids.length, ids });
});
