/**
 * PreCompact run — the hook's flow over injected effects, so the
 * ordering and settle rules are testable without a rollout, a replica or
 * a model. precompact-hook.ts builds the real dependencies.
 *
 * Reads the window since the last compaction, the delta since the
 * watermark and the session's summary state; plans; distils; then writes
 * the watermark and summary state in one write and closes the store
 * before the sync (the hook runs ahead of compaction and a sync can take
 * seconds). Every path closes once, and nothing rejects: a failure is
 * logged once and the run resolves, because the hook exits 0
 * unconditionally.
 */

import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { Logger } from "@mimir/plugin-core/logger";
import { attempt, attemptSync } from "@mimir/plugin-core/result";
import {
  precompactPlan,
  settlePrecompact,
  summaryInput,
} from "./precompact-plan";

type SummaryState = {
  readonly summarizedThrough: number;
  readonly summaryId: string | null;
};

type StateFields = {
  readonly offset?: number;
  readonly summarizedThrough?: number;
  readonly summaryId?: string;
};

export type PreCompactDeps = {
  readonly readWindow: (path: string) => Promise<{
    readonly messages: ModelMessage[];
    readonly lastMessageOffset: number;
    readonly firstOffset: number;
  }>;
  readonly readDelta: (
    path: string,
    watermark: number,
  ) => Promise<{
    readonly messages: ModelMessage[];
    readonly newOffset: number;
  }>;
  readonly readWatermark: (sessionId: string) => Promise<number>;
  readonly readSummaryState: (sessionId: string) => Promise<SummaryState>;
  /** Writes the given state fields at once; absent fields keep theirs. */
  readonly writeState: (
    sessionId: string,
    fields: StateFields,
  ) => Promise<void>;
  /** The stored summary row's text, or null when the row is gone. */
  readonly summaryText: (id: string) => Promise<string | null>;
  readonly summarize: (
    messages: readonly ModelMessage[],
  ) => Promise<{ readonly ok: boolean; readonly id: string | null }>;
  /** Extracts and stores facts; resolves to the count stored. */
  readonly extractFacts: (messages: readonly ModelMessage[]) => Promise<number>;
  readonly sync: () => Promise<void>;
  /** Releases whatever the run opened; safe when nothing was. */
  readonly close: () => void;
  /** The project id memories were attributed to, when the store resolved one. */
  readonly projectId?: () => string | null;
  readonly extraction: Parameters<typeof precompactPlan>[0]["extraction"];
  readonly log: Logger;
};

type RunInput = {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly trigger?: string;
};

const assertNever = (value: never) => {
  throw new Error(`unhandled precompact plan: ${JSON.stringify(value)}`);
};

/** Reads, plans, distils and writes the state; resolves to whether to sync. */
const distil = async (input: RunInput, deps: PreCompactDeps) => {
  const { sessionId, transcriptPath } = input;
  const watermark = await deps.readWatermark(sessionId);
  const summaryState = await deps.readSummaryState(sessionId);
  const window = await deps.readWindow(transcriptPath);
  const delta = await deps.readDelta(transcriptPath, watermark);
  const plan = precompactPlan({
    window: window.messages,
    delta: delta.messages,
    lastMessageOffset: window.lastMessageOffset,
    summarizedThrough: summaryState.summarizedThrough,
    extraction: deps.extraction,
  });
  const sizes = {
    sessionId,
    trigger: input.trigger ?? "unknown",
    messagesInWindow: window.messages.length,
    messagesInDelta: delta.messages.length,
  };

  switch (plan.kind) {
    case "caught-up": {
      if (delta.newOffset > watermark) {
        await deps.writeState(sessionId, { offset: delta.newOffset });
      }
      deps.log.info("precompact: nothing new to distill", {
        ...sizes,
        watermark,
        newOffset: delta.newOffset,
        lastMessageOffset: window.lastMessageOffset,
        summarizedThrough: summaryState.summarizedThrough,
      });
      return false;
    }
    case "unconfigured": {
      await deps.writeState(sessionId, { offset: delta.newOffset });
      deps.log.warn(
        "extraction unconfigured — precompact window not distilled",
        sizes,
      );
      return false;
    }
    case "distill":
      break;
    default:
      return assertNever(plan);
  }

  // Only a summary of an earlier window is carried: one ending at or past
  // this window's first line already covers part of this window (a
  // compaction that aborted after the hook ran).
  const carry =
    plan.summary &&
    summaryState.summaryId &&
    summaryState.summarizedThrough < window.firstOffset
      ? summaryState.summaryId
      : null;
  const previousSummary = carry ? await deps.summaryText(carry) : null;
  const summary = plan.summary
    ? await deps.summarize(
        summaryInput({ window: plan.summary, previousSummary }),
      )
    : null;

  // A failed summary reads no facts and writes nothing. That is not a
  // retry: the next window starts after this compaction's boundary, so
  // this window is never summarised again. Its delta's facts are not
  // lost — the rollout is append-only, so the Stop hook still reads them
  // from the unmoved watermark.
  const factsStored =
    plan.facts && (!summary || summary.ok)
      ? await deps.extractFacts(plan.facts)
      : 0;

  const settled = settlePrecompact({ summary, factsStored });
  const outcome = {
    ...sizes,
    previousSummaryCarried: Boolean(previousSummary),
    summaryId: summary?.id ?? null,
    factsStored,
    model: deps.extraction?.model ?? null,
  };
  if (!settled.advance) {
    deps.log.error(
      "precompact: summarization failed — window not summarised, watermark kept",
      outcome,
    );
    return false;
  }

  await deps.writeState(sessionId, {
    offset: delta.newOffset,
    ...(settled.markSummarized && summary?.id
      ? {
          summarizedThrough: window.lastMessageOffset,
          summaryId: summary.id,
        }
      : {}),
  });

  deps.log.info("precompact: window distilled locally", {
    ...outcome,
    projectId: deps.projectId?.() ?? null,
    watermark,
    newOffset: delta.newOffset,
  });

  return settled.sync;
};

export const runPreCompact = async (input: RunInput, deps: PreCompactDeps) => {
  const context = {
    sessionId: input.sessionId,
    trigger: input.trigger ?? "unknown",
  };
  const [runErr, sync] = await attempt(() => distil(input, deps));
  const [closeErr] = attemptSync(() => deps.close());
  if (runErr) {
    deps.log.error("precompact: run failed — nothing more distilled", {
      ...context,
      error: runErr.message,
    });
    return;
  }
  if (closeErr) {
    deps.log.error("precompact: store close failed — sync skipped", {
      ...context,
      error: closeErr.message,
    });
    return;
  }
  if (!sync) return;
  const [syncErr] = await attempt(() => deps.sync());
  if (syncErr) {
    deps.log.error("precompact: sync failed — distilled rows stay local", {
      ...context,
      error: syncErr.message,
    });
  }
};
