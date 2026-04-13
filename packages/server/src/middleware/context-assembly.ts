/**
 * Middleware 3: Context Assembly
 *
 * Builds the context window for the LLM from:
 * - Last N summaries from Goldfish (timestamped entries)
 * - Recent messages from message_log since last summary
 * - Memories (already retrieved by MW2)
 * - Project rules (from session context)
 *
 * Context assembly is the core job of the single-brain architecture.
 *
 * Message flow after compaction:
 *   [system prompt]
 *   [synthetic user]: "Session context:\n<summaries>...<memories>...<rules>..."
 *   [synthetic assistant]: "Understood."
 *   [...recentMessages from DB as real conversation turns...]
 *
 * recentMessages from the DB are the source of truth for conversation history.
 * They flow as actual ModelMessage turns so tool calls, tool results, and
 * reasoning content are preserved — not flattened into prose.
 */

import type { ModelMessage } from "ai";
import {
  appendNewMessages,
  getModelMessagesSince,
  getRecentModelMessages,
} from "../agent-loop/message-log/index";
import { config } from "../config";
import { getLastSummaries } from "../goldfish/store";
import { log } from "../util/logger";
import type { MimirContext } from "./types";

/**
 * Prune old tool results to keep context manageable.
 * Keeps only the last N tool result messages.
 */
function pruneOldToolResults(
  messages: ModelMessage[],
  keepLast: number,
): { messages: ModelMessage[]; pruned: number } {
  const toolResultMsgs = messages.filter((m) => m.role === "tool");
  if (toolResultMsgs.length <= keepLast) {
    return { messages, pruned: 0 };
  }

  const toRemove = toolResultMsgs.length - keepLast;
  const removeIds = new Set(
    toolResultMsgs.slice(0, toRemove).map((m) => {
      if (Array.isArray(m.content) && m.content.length > 0) {
        const part = m.content[0];
        if (part && "toolCallId" in part) {
          return (part as { toolCallId: string }).toolCallId;
        }
      }
      return null;
    }),
  );

  const pruned = messages.filter((m) => {
    if (m.role !== "tool") return true;
    if (Array.isArray(m.content) && m.content.length > 0) {
      const part = m.content[0];
      if (part && "toolCallId" in part) {
        return !removeIds.has((part as { toolCallId: string }).toolCallId);
      }
    }
    return true;
  });

  return { messages: pruned, pruned: toRemove };
}

/**
 * Assemble the complete context for the LLM.
 *
 * Order: summaries → memories → rules → format reminder
 */
export async function assembleContext(ctx: MimirContext): Promise<void> {
  const start = Date.now();

  // 1. Persist only NEW messages from the request.
  // The client sends the full conversation history every time. We only need
  // to append the messages that aren't already in the DB.
  // Skip system messages — they're injected fresh by the system prompt middleware.
  //
  // Gate: only persist if the request includes tools. Clients like Cherry Studio
  // send utility requests (title generation, summarization) through the same
  // endpoint — those have no tools and must not pollute the message log.
  const hasTools = (ctx.request.tools ?? []).length > 0;
  if (hasTools) {
    const nonSystemMessages = ctx.request.messages.filter(
      (m) => m.role !== "system",
    );
    await appendNewMessages(nonSystemMessages, ctx.project).catch((err) =>
      log.error({ err }, "failed to append new messages"),
    );
  } else {
    log.debug(
      "skipping message persistence — no tools (likely utility request)",
    );
  }

  // 2. Get last N summaries (global, newest first from DESC order)
  const summaries = await getLastSummaries(3);

  // 3. Get conversation messages
  //
  // DB is always the source of truth. Two modes:
  //
  //   Post-compaction (summaries exist): Read messages since the last summary.
  //   The summary replaces everything before its timestamp, so we cap to
  //   keepRecentMessages to avoid context explosion between compaction cycles.
  //
  //   Pre-compaction (no summaries): Read all messages from the DB — no cap.
  //   Nothing has been summarized yet, so every message matters.
  let recentMessages: ModelMessage[];
  if (summaries.length > 0 && summaries[0]?.created_at) {
    const lastSummaryTime = new Date(summaries[0].created_at);
    log.info(
      {
        lastSummaryTime: lastSummaryTime.toISOString(),
        summaryCount: summaries.length,
      },
      "getMessagesSince threshold",
    );
    recentMessages = await getModelMessagesSince(lastSummaryTime);
    // Cap to avoid context explosion between compaction cycles
    if (recentMessages.length > config.context.keepRecentMessages) {
      recentMessages = recentMessages.slice(-config.context.keepRecentMessages);
    }
  } else {
    // No summaries yet — read full history from DB, no cap
    recentMessages = await getRecentModelMessages();
  }

  // 3. Build context injection (summaries + memories + rules)
  const contextParts: string[] = [];

  if (summaries.length > 0) {
    const summaryText = summaries
      .map((s, i) => `[Summary ${i + 1}]\n${s.content}`)
      .join("\n\n");
    contextParts.push(`<summaries>\n${summaryText}\n</summaries>`);
  }

  if (ctx.memories) {
    contextParts.push(`<memories>\n${ctx.memories}\n</memories>`);
  }

  // Build the synthetic context injection pair
  if (contextParts.length > 0) {
    ctx.contextInjection = [
      {
        role: "user",
        content: `Session context:\n${contextParts.join("\n\n")}`,
      },
      { role: "assistant", content: "Understood." },
    ];
  }

  // 4. Prune old tool results to keep context manageable.
  //    Old tool results are removed entirely (pruning), so we don't also
  //    need to truncate the ones we keep — the model needs full content
  //    of recent tool results to work effectively.
  const { messages: prunedMessages, pruned } = pruneOldToolResults(
    recentMessages,
    config.context.keepRecentToolResults,
  );
  if (pruned > 0) {
    log.info({ pruned }, "tool result cleanup");
  }
  ctx.conversationMessages = prunedMessages;

  log.info(
    {
      summaries: summaries.length,
      recentMessages: recentMessages.length,
      hasMemories: !!ctx.memories,
      contextParts: contextParts.length,
      conversationMessages: ctx.conversationMessages.length,
      elapsed: `${Date.now() - start}ms`,
    },
    "context assembly complete",
  );
}
