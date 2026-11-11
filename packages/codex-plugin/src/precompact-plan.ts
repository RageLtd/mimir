/**
 * PreCompact decisions — what a compaction owes, what the summariser
 * reads, and how a distill settles. Pure: precompact-runner.ts applies
 * them to the effects precompact-hook.ts wires. The plan and settle rules
 * are plugin-core's; this file holds what is Codex's: the summary mark is
 * a rollout offset, and the summariser carries the previous summary.
 */

import type { ModelMessage } from "@ai-sdk/provider-utils";
import {
  compactionPlan,
  settleCompaction,
} from "@mimir/plugin-core/brain/compaction-plan";
import type { extractionConfig } from "@mimir/plugin-core/shared-config";

/**
 * What this compaction owes: a summary is due when the window's last
 * message lies past the summary mark.
 */
export const precompactPlan = (input: {
  readonly window: readonly ModelMessage[];
  readonly delta: readonly ModelMessage[];
  readonly lastMessageOffset: number;
  readonly summarizedThrough: number;
  readonly extraction: Awaited<ReturnType<typeof extractionConfig>>;
}) =>
  compactionPlan({
    window: input.window,
    delta: input.delta,
    summaryDue: input.lastMessageOffset > input.summarizedThrough,
    configured: Boolean(input.extraction),
  });

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

/** How a distill settles — plugin-core's shared rule under Codex's name. */
export const settlePrecompact = settleCompaction;
