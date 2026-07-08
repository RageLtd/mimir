/**
 * Middleware 3: Context Assembly
 *
 * Builds the context window for the LLM from:
 * - Last N summaries from Goldfish (timestamped entries)
 * - The request's own messages (the client owns the transcript — MIM-86)
 * - Memories (already retrieved by MW2)
 * - Project rules (from session context)
 *
 * Message flow (summaries are ADDITIVE, never replace raw recent messages):
 *   [system prompt]
 *   [synthetic user]: "Session context:\n<summaries>...<memories>...<rules>..."
 *   [synthetic assistant]: "Understood."
 *   [...the request's conversation messages as real turns...]
 *
 * The server keeps no conversation log. Conversations are personal,
 * per-machine artifacts; the org-shared artifact is the extracted memory,
 * never the transcript. Cross-session replay ended with the server-side
 * message_log (restored client-side by MIM-89's inversion).
 */

import { getLastSummaries } from "../goldfish/store";
import { log } from "../util/logger";
import type { MimirContext } from "./types";

/**
 * Build the synthetic context injection pair from summaries, memories, and rules.
 *
 * Returns a two-element ModelMessage array (user + assistant) when there's
 * content to inject, or an empty array when there's nothing. This is the
 * single source of truth for the injection format.
 */
export function buildContextInjection(
  summaries: Array<{ content: string }>,
  memories: string | null | undefined,
  projectRules?: string | null,
  playbooks?: string | null,
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

  if (playbooks) {
    contextParts.push(`<playbooks>\n${playbooks}\n</playbooks>`);
  }

  if (projectRules) {
    contextParts.push(`<project_rules>\n${projectRules}\n</project_rules>`);
  }

  if (contextParts.length === 0) return [];

  return [
    {
      role: "user" as const,
      content: `Session context:\n${contextParts.join("\n\n")}`,
    },
    { role: "assistant" as const, content: "Understood." },
  ];
}

/**
 * Assemble the complete context for the LLM.
 *
 * Order: summaries → memories → rules, then the request's own messages.
 * The request is the source of truth for the conversation — clients
 * (ACP sessions, CC) carry their full message history on every call.
 */
export async function assembleContext(ctx: MimirContext) {
  const start = Date.now();

  // System messages are excluded — the system prompt middleware injects
  // its own; a client-sent system message must not double up.
  const conversationMessages = ctx.request.messages.filter(
    (m) => m.role !== "system",
  );

  const summaries = await getLastSummaries(ctx.scope, 3);

  ctx.contextInjection = buildContextInjection(
    summaries,
    ctx.memories,
    ctx.projectRules,
    ctx.playbooks,
  );
  ctx.conversationMessages = conversationMessages;

  log.info(
    {
      summaries: summaries.length,
      conversationMessages: conversationMessages.length,
      hasMemories: !!ctx.memories,
      hasPlaybooks: !!ctx.playbooks,
      injectionPairs: ctx.contextInjection.length,
      elapsed: `${Date.now() - start}ms`,
    },
    "context assembly complete",
  );
}
