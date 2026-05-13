/**
 * Middleware 2: Goldfish Memory Retrieval
 *
 * Retrieves relevant memories from long-term memory and injects them
 * into the context. Uses the last user message as the search query.
 */

import type { ModelMessage } from "ai";
import { modelContentToString } from "../agent-loop/message-log/message-utils";
import { retrieveMemories } from "../goldfish/memory";
import { log } from "../util/logger";
import type { MimirContext } from "./types";

/**
 * Retrieve memories based on the last user message and inject into context.
 */
export async function injectMemories(ctx: MimirContext) {
  const start = Date.now();

  // Extract query from the last user message
  const lastUser = [...ctx.request.messages]
    .reverse()
    .find((m) => m.role === "user");

  if (!lastUser) {
    ctx.memories = null;
    log.debug("no user message found, skipping memory retrieval");
    return;
  }

  const query = modelContentToString(lastUser.content);

  if (!query) {
    ctx.memories = null;
    log.debug("user message has no text content, skipping memory retrieval");
    return;
  }

  // Build a mini message array for the retrieval API
  const messages: ModelMessage[] = [lastUser];

  const memories = await retrieveMemories(messages);
  ctx.memories = memories;

  log.info(
    {
      queryLength: query.length,
      hasMemories: !!memories,
      memoriesLength: memories?.length ?? 0,
      elapsed: `${Date.now() - start}ms`,
    },
    "memory retrieval complete",
  );
}
