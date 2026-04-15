/**
 * Core Copilot runner using the Copilot SDK.
 *
 * Uses CopilotClient from @github/copilot-sdk to create streaming sessions.
 * The SDK uses a callback/event model (session.on(...)), so we bridge
 * callbacks into an async generator via a push queue. The generator yields
 * the same BackendEvent stream as the CC runner.
 */

import { CopilotClient } from "@github/copilot-sdk";
import { errMessage } from "../../util";
import { createChildLogger, log } from "../../utils/log";
import { createPushQueue } from "../../utils/push-queue";
import type { BackendEvent } from "../types";
import {
  buildCopilotSessionOptions,
  type RunCopilotOptions,
} from "./formatting";

const logger = createChildLogger(log, "copilot-runner");

export const runCopilot = async function* (
  options: RunCopilotOptions,
): AsyncGenerator<BackendEvent> {
  const client = new CopilotClient();
  const queue = createPushQueue<BackendEvent>();
  const sessionOptions = buildCopilotSessionOptions(options);

  let sessionId: string | undefined;

  const cleanup = async () => {
    try {
      await client.stop();
    } catch (err) {
      logger.debug(
        "client.stop() error (expected during abort):",
        errMessage(err),
      );
    }
  };

  // Wire up abort signal to cancel the session.
  if (options.signal) {
    options.signal.addEventListener(
      "abort",
      () => {
        queue.push({ type: "finish", sessionId, stopReason: "cancelled" });
        queue.end();
        cleanup();
      },
      { once: true },
    );
  }

  try {
    await client.start();

    const session = await client.createSession(sessionOptions);
    sessionId = session.sessionId;

    // Emit init event with the session id.
    queue.push({
      type: "init",
      sessionId: sessionId ?? "copilot",
      tools: [],
    });

    // Wire up streaming event handlers.
    session.on("assistant.message_delta", (event) => {
      const text = event.data?.deltaContent ?? "";
      if (text) {
        queue.push({ type: "text", text });
      }
    });

    session.on("assistant.reasoning_delta", (event) => {
      const text = event.data?.deltaContent ?? "";
      if (text) {
        queue.push({ type: "thinking", text });
      }
    });

    session.on("session.idle", () => {
      queue.push({ type: "finish", sessionId });
      queue.end();
    });

    // Send the prompt and wait for completion.
    // sendAndWait blocks until session.idle, at which point the queue is ended.
    await session.sendAndWait({ prompt: options.prompt });

    // Disconnect the session after completion.
    await session.disconnect();
  } catch (err) {
    if (options.signal?.aborted) {
      // Already handled by the abort listener.
    } else {
      const msg = errMessage(err);
      logger.error("Copilot session error:", msg);
      queue.push({ type: "error", error: msg });
      queue.push({ type: "finish", sessionId });
      queue.end();
    }
  } finally {
    await cleanup();
  }

  // Yield all buffered and future events from the queue.
  yield* queue.iterator;
};
