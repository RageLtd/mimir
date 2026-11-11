/**
 * PreCompact decisions — what a compaction owes, what the summariser
 * reads, and how a distill settles. Pure: precompact-runner.ts applies
 * them to the effects precompact-hook.ts wires.
 */

import type { ModelMessage } from "@ai-sdk/provider-utils";
import { prepareSummary } from "@mimir/plugin-core/brain/summarize";
import type { extractionConfig } from "@mimir/plugin-core/shared-config";

/**
 * What this compaction owes: a summary of the window when its last
 * message lies past the summary mark and the window alone clears the
 * summary floor, and facts from the delta when it is non-empty.
 */
export const precompactPlan = (input: {
  readonly window: readonly ModelMessage[];
  readonly delta: readonly ModelMessage[];
  readonly lastMessageOffset: number;
  readonly summarizedThrough: number;
  readonly extraction: Awaited<ReturnType<typeof extractionConfig>>;
}) => {
  const summary =
    input.lastMessageOffset > input.summarizedThrough &&
    !("skipped" in prepareSummary(input.window))
      ? input.window
      : null;
  const facts = input.delta.length > 0 ? input.delta : null;
  if (!summary && !facts) return { kind: "caught-up" as const };
  if (!input.extraction) return { kind: "unconfigured" as const };
  return { kind: "distill" as const, summary, facts };
};

/**
 * The summariser's input: the session's previous summary, labelled, as
 * one user message ahead of the window — or the window alone.
 */
export const summaryInput = (input: {
  readonly window: readonly ModelMessage[];
  readonly previousSummary: string | null;
}) => {
  if (!input.previousSummary) return [...input.window];
  const carried: ModelMessage = {
    role: "user",
    content: `Summary of this session before the last compaction:\n\n${input.previousSummary}`,
  };
  return [carried, ...input.window];
};

/**
 * How a distill settles. A failed summary writes nothing; otherwise the
 * watermark advances, the window is marked summarised only when a
 * summary was stored, and a sync runs when anything landed.
 */
export const settlePrecompact = (input: {
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
