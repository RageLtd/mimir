/**
 * Middleware 2: Goldfish Memory Retrieval
 *
 * Retrieves relevant memories from long-term memory and injects them
 * into the context. Uses the last user message as the search query.
 */

import type { ModelMessage } from "ai";
import { retrieveMemories } from "../goldfish/memory";
import { buildPlaybookContext } from "../goldfish/playbook";
import { log } from "../util/logger";
import { modelContentToString } from "../util/model-message";
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
    ctx.playbooks = null;
    log.debug("user message has no text content, skipping memory retrieval");
    return;
  }

  // Build a mini message array for the retrieval API
  const messages: ModelMessage[] = [lastUser];

  // Memories (shared fact top-K) and playbooks (separate index + ambient
  // budget, keyed on the active project) are retrieved together but kept on
  // independent budgets — see goldfish/playbook.ts.
  const [memories, playbooks] = await Promise.all([
    retrieveMemories(ctx.scope, messages),
    buildPlaybookContext(ctx.scope, query, {
      projectIdentifier: ctx.projectId ?? undefined,
    }),
  ]);
  ctx.memories = memories;
  ctx.playbooks = playbooks;

  log.info(
    {
      queryLength: query.length,
      hasMemories: !!memories,
      memoriesLength: memories?.length ?? 0,
      hasPlaybooks: !!playbooks,
      elapsed: `${Date.now() - start}ms`,
    },
    "memory retrieval complete",
  );
}
