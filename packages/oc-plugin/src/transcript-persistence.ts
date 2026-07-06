/**
 * Transcript persistence — fetch the full session transcript from
 * OpenCode's server and ship it to mimir-server's /v1/messages/persist.
 *
 * The cc-plugin's pattern reads CC's JSONL transcript file, coalesces
 * streaming chunks, and tracks a watermark per session. OpenCode's
 * server-side message store is the source of truth here — we don't
 * need to accumulate or coalesce because OpenCode has already done
 * that. On `session.idle` we just fetch the full message list with
 * parts and POST the lot.
 *
 * The server's `appendTurn` function dedupes by fingerprint, so
 * re-persisting the same transcript across multiple `session.idle`
 * fires is safe (and expected — the plugin runs in-process across
 * all events in the lifetime of one OpenCode session).
 *
 * Errors are logged but never block the session going idle. A failed
 * persist just means the server didn't get the transcript; the user
 * can re-trigger via /mimir-update or by inspecting the log.
 */

import { getOrResolveProjectId } from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import { errMessage } from "@mimir/plugin-core/util";
import { authHeaders, type MimirConfig } from "./config";

const PERSIST_ROUTE = "/v1/messages/persist";

// ── ModelMessage shape ──
//
// The mimir-server's persist endpoint accepts the AI SDK's
// ModelMessage shape. We don't import the type from the AI SDK
// directly — the type is purely structural and the import would
// pull @ai-sdk/provider-utils into the published bundle. Defining
// it locally keeps the bundle small and the contract obvious.

type AssistantContent =
  | { type: "text"; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      input: Record<string, unknown>;
    };

type ModelMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: AssistantContent[] };

// ── OpenCode SDK types (narrow) ──
//
// The OpenCode SDK is auto-generated; we only touch the fields we
// actually use. Type-checking the return value of `client.session.messages`
// is more brittle than re-declaring the narrow shape we need.

type OpenCodeTextPart = { type: "text"; text?: string };
type OpenCodeToolPart = {
  type: "tool";
  callID?: string;
  name?: string;
  input?: Record<string, unknown>;
};
type OpenCodePart = OpenCodeTextPart | OpenCodeToolPart | { type: string };

// Resolved variants — the fields we require are present and string-typed.
// The type guards below narrow to these so downstream reads need no `as`
// cast and no `| undefined` on callID/name/text.
type ResolvedTextPart = { type: "text"; text: string };
type ResolvedToolPart = {
  type: "tool";
  callID: string;
  name: string;
  input?: Record<string, unknown>;
};

const isTextPart = (p: OpenCodePart): p is ResolvedTextPart =>
  p.type === "text" && "text" in p && typeof p.text === "string";

const isToolPart = (p: OpenCodePart): p is ResolvedToolPart =>
  p.type === "tool" &&
  "callID" in p &&
  typeof p.callID === "string" &&
  "name" in p &&
  typeof p.name === "string";

type OpenCodeMessageInfo = {
  id: string;
  sessionID: string;
  role: "user" | "assistant" | "tool";
};

type OpenCodeMessage = { info: OpenCodeMessageInfo; parts: OpenCodePart[] };

// ── OpenCode client shape (narrow) ──
//
// We only need `session.messages`. The plugin entry passes the full
// SDK client through; the narrow type here documents what we touch.
// The real SDK wraps every response as `{ data, error } & { request,
// response }`, so `messages` resolves to the wrapped envelope — we unwrap
// `.data` (and surface `.error`) before iterating.

type MessagesResponse = {
  readonly data?: readonly OpenCodeMessage[];
  readonly error?: unknown;
};

type TranscriptClient = {
  readonly session: {
    readonly messages: (args: {
      readonly path: { readonly id: string };
    }) => Promise<MessagesResponse>;
  };
};

type TranscriptLogger = {
  readonly debug: (message: string, context?: unknown) => void;
  readonly info: (message: string, context?: unknown) => void;
  readonly warn: (message: string, context?: unknown) => void;
  readonly error: (message: string, context?: unknown) => void;
};

/**
 * Convert OpenCode's `{ info, parts }` shape into the AI SDK's
 * ModelMessage. Returns null for messages we don't persist (tool
 * role, empty assistant turns, etc.) — caller filters those out.
 */
export const convertMessage = (msg: OpenCodeMessage) => {
  if (msg.info.role === "user") {
    // User text lives in the message's text parts — NOT in
    // `info.summary.body`, which is the compaction summary and is unset
    // for ordinary turns. Reading summary.body persisted every user turn
    // empty; read the parts, same as the assistant branch.
    const text = msg.parts
      .filter(isTextPart)
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text.length === 0) return null;
    const out: ModelMessage = { role: "user", content: text };
    return out;
  }
  if (msg.info.role === "assistant") {
    const content: AssistantContent[] = [];
    for (const part of msg.parts) {
      if (isTextPart(part)) {
        content.push({ type: "text", text: part.text });
        continue;
      }
      if (isToolPart(part)) {
        content.push({
          type: "tool-call",
          toolCallId: part.callID,
          toolName: part.name,
          input: part.input ?? {},
        });
      }
      // reasoning, files, step markers, retries, compaction, etc.
      // are auxiliary — skip.
    }
    if (content.length === 0) return null;
    const out: ModelMessage = { role: "assistant", content };
    return out;
  }
  // role === "tool" and any other future roles: auxiliary, skip.
  return null;
};

/**
 * Fetch the session's transcript from OpenCode and POST it to the
 * mimir-server's persist endpoint. Fire-and-forget: errors are
 * logged but never propagated.
 */
export const persistSessionTranscript = async (
  sessionID: string,
  projectPath: string,
  config: MimirConfig,
  log: TranscriptLogger,
  client: TranscriptClient,
): Promise<void> => {
  const [fetchErr, result] = await attempt(() =>
    client.session.messages({ path: { id: sessionID } }),
  );
  if (fetchErr) {
    log.error("transcript fetch failed", {
      sessionID,
      error: errMessage(fetchErr),
    });
    return;
  }
  if (result.error) {
    log.error("transcript fetch returned error", {
      sessionID,
      error: String(result.error),
    });
    return;
  }
  const messages = result.data ?? [];

  if (messages.length === 0) {
    log.debug("session idle — no messages to persist", { sessionID });
    return;
  }

  const modelMessages: ModelMessage[] = [];
  for (const msg of messages) {
    const converted = convertMessage(msg);
    if (converted) modelMessages.push(converted);
  }

  if (modelMessages.length === 0) {
    log.debug("session idle — no convertible messages", { sessionID });
    return;
  }

  let projectId: string | null = null;
  try {
    projectId = await getOrResolveProjectId(
      config.serverUrl,
      projectPath,
      config.apiKey,
    );
  } catch (err) {
    log.warn("project id resolve failed", {
      sessionID,
      error: errMessage(err),
    });
  }

  const url = `${config.serverUrl.replace(/\/+$/, "")}${PERSIST_ROUTE}`;
  const headers = await authHeaders();
  const body = JSON.stringify({
    messages: modelMessages,
    project: projectPath,
    ...(projectId ? { projectId } : {}),
  });

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
    if (!response.ok) {
      const responseText = await response.text().catch(() => "");
      log.error("transcript persist non-OK", {
        sessionID,
        status: response.status,
        body: responseText,
      });
      return;
    }
    log.info("transcript persisted", {
      sessionID,
      messageCount: modelMessages.length,
    });
  } catch (err) {
    log.error("transcript persist fetch failed", {
      sessionID,
      error: errMessage(err),
    });
  }
};
