/**
 * Memory hygiene orchestrator.
 *
 * runHygieneSweep coordinates the two v1 passes — consolidation then
 * forgetting — behind the global hygiene lock. It is callable both from the
 * periodic scheduler and from the manual POST /v1/hygiene/sweep route.
 *
 * The sweep REFUSES to run when HYGIENE_MODEL is unset: consolidation needs a
 * capable judgment model, and silently merging memories with the wrong one is
 * worse than not merging at all.
 */

import { config } from "../../config";
import { log } from "../../util/logger";
import { attempt } from "../../util/result";
import { listAllMemories } from "../store-hygiene";
import { type ConsolidationReport, runConsolidation } from "./consolidate";
import { type ForgettingReport, runForgetting } from "./forget";
import { getHygieneModelConfig } from "./llm";
import { finishHygiene, resetHygieneLock, startHygiene } from "./state";

export interface SweepReport {
  readonly dryRun: boolean;
  readonly skipped?: string;
  readonly model?: string;
  readonly memoryCount?: number;
  readonly consolidation?: ConsolidationReport;
  readonly forgetting?: ForgettingReport;
  readonly elapsedMs?: number;
}

export interface SweepOpts {
  /** Override the configured dry-run default (manual route passes this). */
  readonly dryRun?: boolean;
}

export async function runHygieneSweep(
  opts: SweepOpts = {},
): Promise<SweepReport> {
  const dryRun = opts.dryRun ?? config.hygiene.dryRun;

  const modelCfg = getHygieneModelConfig();
  if (!modelCfg) {
    log.warn("hygiene sweep skipped — HYGIENE_MODEL unset");
    return { dryRun, skipped: "HYGIENE_MODEL unset" };
  }

  const acquired = await startHygiene();
  if (!acquired) {
    return { dryRun, skipped: "another sweep is already running" };
  }

  const start = Date.now();
  log.info({ dryRun, model: modelCfg.model }, "hygiene sweep starting");

  const [err, report] = await attempt(async () => {
    const memories = await listAllMemories();

    const consolidation = await runConsolidation(memories, {
      dryRun,
      mergeDistance: config.hygiene.consolidation.mergeDistance,
      maxClusterSize: config.hygiene.consolidation.maxClusterSize,
      maxMergesPerSweep: config.hygiene.consolidation.maxMergesPerSweep,
    });

    // After a live consolidation the store has changed — re-read so the
    // forgetting pass scores the post-merge set. In dry-run nothing moved.
    const forgetMemories = dryRun ? memories : await listAllMemories();

    const forgetting = await runForgetting(forgetMemories, {
      dryRun,
      scoreFloor: config.hygiene.forget.scoreFloor,
      minAgeDays: config.hygiene.forget.minAgeDays,
      maxPrunes: config.hygiene.forget.maxPrunesPerSweep,
      confidenceDecay: config.hygiene.forget.confidenceDecay,
      decayOlderThanSeconds: Math.round(config.hygiene.intervalMs / 1000),
      now: Date.now(),
    });

    return {
      dryRun,
      model: modelCfg.model,
      memoryCount: memories.length,
      consolidation,
      forgetting,
      elapsedMs: Date.now() - start,
    } satisfies SweepReport;
  });

  // Release the lock whether the sweep succeeded or failed.
  await finishHygiene();

  if (err || !report) {
    log.error({ err, dryRun }, "hygiene sweep failed");
    return {
      dryRun,
      skipped: `sweep failed: ${err?.message ?? "unknown error"}`,
    };
  }

  log.info(
    {
      dryRun,
      merged: report.consolidation?.merged,
      clustersFound: report.consolidation?.clustersFound,
      pruned: report.forgetting?.prunedCount,
      decayed: report.forgetting?.decayedCount,
      elapsedMs: report.elapsedMs,
    },
    "hygiene sweep complete",
  );
  return report;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic sweep. No-op if disabled or already started. */
export async function startHygieneScheduler(): Promise<void> {
  if (!config.hygiene.enabled) {
    log.info("hygiene scheduler disabled (HYGIENE_ENABLED=false)");
    return;
  }
  if (timer) return;

  // Boot means no sweep is in flight — clear any lock left stuck by a process
  // killed mid-sweep (e.g. a redeploy during a long sweep) so manual sweeps
  // aren't blocked until the stale window elapses.
  await resetHygieneLock();

  if (!getHygieneModelConfig()) {
    log.warn(
      "hygiene scheduler enabled but HYGIENE_MODEL unset — sweeps will skip until configured",
    );
  }

  timer = setInterval(() => {
    runHygieneSweep().catch((err) =>
      log.error({ err }, "scheduled hygiene sweep threw"),
    );
  }, config.hygiene.intervalMs);

  log.info(
    { intervalMs: config.hygiene.intervalMs, dryRun: config.hygiene.dryRun },
    "hygiene scheduler started",
  );
}

/** Stop the periodic sweep (graceful shutdown). */
export function stopHygieneScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
    log.info("hygiene scheduler stopped");
  }
}
