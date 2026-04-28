/**
 * Session-lifecycle notification helpers.
 *
 * Pure side-effect functions that push `session/update` notifications to the
 * editor — extracted from handlers.ts to keep that file under the 500-line
 * ceiling and to give these utilities a clear home that doesn't depend on
 * the full HandlerDeps surface.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { createChildLogger, log } from "../utils/log";
import { AVAILABLE_COMMANDS } from "./session";
import type { AgentCore } from "./types";

const logger = createChildLogger(log, "lifecycle-helpers");

/**
 * Emit a single `agent_message_chunk` text update — the canonical way to
 * surface assistant-side output to the editor (streaming text, error
 * banners, command output, replayed history).
 *
 * Returns the underlying promise so callers in streaming hot-paths can
 * `await` it; fire-and-forget call sites discard the result.
 */
export const emitAgentText = (
  conn: acp.AgentSideConnection,
  sessionId: string,
  text: string,
) =>
  conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  });

/**
 * Emit a `user_message_chunk` text update. Used during loadSession history
 * replay; the live prompt path doesn't echo user input back through this
 * channel.
 */
export const emitUserText = (
  conn: acp.AgentSideConnection,
  sessionId: string,
  text: string,
) =>
  conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text },
    },
  });

/**
 * Push the slash-command catalogue to the editor as an
 * available_commands_update notification.
 */
export const emitCommandsList = (
  conn: acp.AgentSideConnection,
  sessionId: string,
) => {
  conn
    .sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: AVAILABLE_COMMANDS,
      },
    })
    .catch((err) => logger.warn("available_commands_update failed:", err));
};

/**
 * Emit the commands list once per session. Called from newSession (deferred
 * via setTimeout(0) so the response is sent first) and loadSession. The
 * `emitted` Set deduplicates double-sends when both paths hit the same
 * session.
 */
export const maybeEmitCommandsList = (
  conn: acp.AgentSideConnection,
  emitted: Set<string>,
  sessionId: string,
) => {
  if (emitted.has(sessionId)) return;
  emitted.add(sessionId);
  emitCommandsList(conn, sessionId);
};

/**
 * Replay a session's persisted message history to the editor as
 * user_message_chunk / agent_message_chunk updates so loading a prior
 * session repopulates the conversation panel. Failures are logged at
 * debug level — the caller has no recovery path during session
 * restoration, but silently swallowing makes "why didn't this message
 * appear?" undebuggable.
 */
export const replayHistoryToEditor = (
  conn: acp.AgentSideConnection,
  sessionId: string,
  messages: readonly { role: string; content: string | null }[],
) => {
  const onFail = (kind: string) => (err: unknown) =>
    logger.debug(`replay ${kind} chunk failed:`, err);

  for (const msg of messages) {
    if (!msg.content) continue;
    if (msg.role === "user") {
      emitUserText(conn, sessionId, msg.content).catch(onFail("user_message"));
    } else if (msg.role === "assistant") {
      emitAgentText(conn, sessionId, msg.content).catch(
        onFail("agent_message"),
      );
    }
  }
};

/**
 * Set the session title to a normalised slice of the first user prompt
 * (60 chars, whitespace collapsed) when the session has none. No-op when
 * the session already has a title or when the prompt slices to empty.
 */
export const maybeSetSessionTitle = (
  core: AgentCore,
  conn: acp.AgentSideConnection,
  sessionId: string,
  promptText: string,
) => {
  const session = core.getSession(sessionId);
  if (!session || session.title) return;
  const title = promptText.slice(0, 60).replace(/\s+/g, " ").trim();
  if (!title) return;
  core.setTitle(sessionId, title);
  conn
    .sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "session_info_update",
        title,
        updatedAt: new Date().toISOString(),
      },
    })
    .catch((err) => logger.warn("session_info_update failed:", err));
};
