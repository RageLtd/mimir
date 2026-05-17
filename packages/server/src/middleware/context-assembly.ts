/**
 * Middleware 3: Context Assembly
 *
 * Builds the context window for the LLM from:
 * - Last N summaries from Goldfish (timestamped entries)
 * - Last N raw messages from message_log (always — never gated on summary time)
 * - Memories (already retrieved by MW2)
 * - Project rules (from session context)
 *
 * Context assembly is the core job of the single-brain architecture.
 *
 * Message flow (summaries are ADDITIVE, never replace raw recent messages):
 *   [system prompt]
 *   [synthetic user]: "Session context:\n<summaries>...<memories>...<rules>..."
 *   [synthetic assistant]: "Understood."
 *   [...last N raw messages from DB as real conversation turns...]
 *
 * Write side: only the client's trailing new user/tool block is appended to
 * the log. Prior messages in the client's `messages` array are informational
 * context only — the DB is source of truth. Assistant outputs are written
 * separately at LLM-turn-end by the runner (see appendAssistantOutput).
 */

import type { ModelMessage } from "ai";
import {
  appendTrailingTurn,
  getLastNModelMessages,
} from "../agent-loop/message-log/index";
import { config } from "../config";
import { getLastSummaries } from "../goldfish/store";
import { log } from "../util/logger";
import type { MimirContext } from "./types";

/**
 * Build the synthetic context injection pair from summaries, memories, and rules.
 *
 * Returns a two-element ModelMessage array (user + assistant) when there's
 * content to inject, or an empty array when there's nothing. This is the
 * single source of truth for the injection format — both the server
 * middleware pipeline and the CC `/assemble` route call it.
 */
export function buildContextInjection(
  summaries: Array<{ content: string }>,
  memories: string | null | undefined,
  projectRules?: string | null,
) {
  const contextParts: string[] = [];

  if (summaries.length > 0) {
    const summaryText = summaries
      .map((s, i) => `[Summary ${i + 1}]\n${s.content}`)
      .join("\n\n");
    contextParts.push(`<summaries>\n${summaryText}\n</summaries>`);
  }

  if (memories) {
    contextParts.push(`<memories>\n${memories}\n</memories>`);
  }

  if (projectRules) {
    contextParts.push(`<project_rules>\n${projectRules}\n</project_rules>`);
  }

  if (contextParts.length === 0) return [];

  const injection: ModelMessage[] = [
    {
      role: "user",
      content: `Session context:\n${contextParts.join("\n\n")}`,
    },
    { role: "assistant", content: "Understood." },
  ];
  return injection;
}

/**
 * Assemble the complete context for the LLM.
 *
 * Order: summaries → memories → rules → format reminder
 */
export async function assembleContext(ctx: MimirContext) {
  const start = Date.now();

  // 1. Persist only the client's trailing new turn (user message or
  //    one-or-more tool results). Everything earlier in the client's
  //    `messages` array is informational — the DB is source of truth.
  //    Assistant outputs are persisted separately by the runner at
  //    LLM-turn-end (see appendAssistantOutput).
  //
  //    Skip system messages — they're injected fresh by the system prompt
  //    middleware. Gate: only persist if the request includes tools.
  //    Clients like Cherry Studio send utility requests (title generation,
  //    summarization) through the same endpoint — those have no tools and
  //    must not pollute the message log.
  const hasTools = (ctx.request.tools ?? []).length > 0;
  if (hasTools) {
    const nonSystemMessages = ctx.request.messages.filter(
      (m) => m.role !== "system",
    );
    await appendTrailingTurn(nonSystemMessages, ctx.project).catch((err) =>
      log.error({ err }, "failed to append trailing turn"),
    );
  } else {
    log.debug(
      "skipping message persistence — no tools (likely utility request)",
    );
  }

  // 2. Get last N summaries (global, newest first from DESC order)
  const summaries = await getLastSummaries(3);

  // 3. Get the last N raw messages from the global log.
  //
  //    Summaries are ADDITIVE — they never replace raw messages in the
  //    read path. The LLM always sees the literal last N conversation
  //    turns, regardless of how recent a summary is. This is what makes
  //    compaction work without the "back in time" symptom: the summary
  //    covers the longer tail, while the most recent exchanges remain
  //    verbatim.
  const recentMessages: ModelMessage[] = await getLastNModelMessages(
    config.context.keepRecentMessages,
  );

  // 4. Build context injection from summaries + memories + rules
  ctx.contextInjection = buildContextInjection(
    summaries,
    ctx.memories,
    ctx.projectRules,
  );
  ctx.conversationMessages = recentMessages;

  log.info(
    {
      summaries: summaries.length,
      recentMessages: recentMessages.length,
      hasMemories: !!ctx.memories,
      injectionPairs: ctx.contextInjection.length,
      conversationMessages: ctx.conversationMessages.length,
      elapsed: `${Date.now() - start}ms`,
    },
    "context assembly complete",
  );
}
