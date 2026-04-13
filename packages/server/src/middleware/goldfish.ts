/**
 * Middleware 2: Goldfish Memory Retrieval
 *
 * Retrieves relevant memories from long-term memory and injects them
 * into the context. Uses the last user message as the search query.
 */

import type { ModelMessage } from "ai";
import { retrieveMemories } from "../goldfish/memory";
import { log } from "../util/logger";
import type { MimirContext } from "./types";

/**
 * Extract text content from a ModelMessage, handling string and array formats.
 */
function messageContentToString(content: ModelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  if (Array.isArray(content)) {
    return content
      .filter(
        (p): p is { type: "text"; text: string } =>
          p.type === "text" && !!p.text,
      )
      .map((p) => p.text)
      .join(" ");
  }
  return "";
}

/**
 * Retrieve memories based on the last user message and inject into context.
 */
export async function injectMemories(ctx: MimirContext): Promise<void> {
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

  const query = messageContentToString(lastUser.content);

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
