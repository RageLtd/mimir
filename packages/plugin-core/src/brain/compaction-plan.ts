/**
 * Compaction decisions shared by every distribution — what a compaction
 * owes and how a distill settles. Pure: each distribution's runner applies
 * them to its own effects.
 */

import type { ConversationMessage } from "./extract";
import { prepareSummary } from "./summarize";

/**
 * What this compaction owes: a summary of the window when one is due and
 * the window alone clears the summary floor, and facts from the delta when
 * it is non-empty. Needs no configuration, so a caller can tell caught-up
 * before resolving an endpoint.
 */
export const compactionOwed = <M extends ConversationMessage>(input: {
  readonly window: readonly M[];
  readonly delta: readonly M[];
  readonly summaryDue: boolean;
}) => ({
  summary:
    input.summaryDue && !("skipped" in prepareSummary(input.window))
      ? input.window
      : null,
  facts: input.delta.length > 0 ? input.delta : null,
});

/** The owed work as a plan. Nothing owed is caught up, even unconfigured. */
export const compactionPlan = <M extends ConversationMessage>(input: {
  readonly window: readonly M[];
  readonly delta: readonly M[];
  readonly summaryDue: boolean;
  readonly configured: boolean;
}) => {
  const { summary, facts } = compactionOwed(input);
  if (!summary && !facts) return { kind: "caught-up" as const };
  if (!input.configured) return { kind: "unconfigured" as const };
  return { kind: "distill" as const, summary, facts };
};

/**
 * How a distill settles. A failed summary writes nothing; otherwise the
 * watermark advances, the window is marked summarised only when a
 * summary was stored, and a sync runs when anything landed.
 */
export const settleCompaction = (input: {
  readonly summary: { readonly ok: boolean; readonly id: string | null } | null;
  readonly factsStored: number;
}) => {
  if (input.summary && !input.summary.ok) {
    return { advance: false, markSummarized: false, sync: false };
  }
  const stored = input.summary?.id != null;
  return {
    advance: true,
    markSummarized: stored,
    sync: stored || input.factsStored > 0,
  };
};
