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
import { rootScope } from "../../db/scope";
import { getDb } from "../../db/surreal";
import { log } from "../../util/logger";
import { attempt } from "../../util/result";
import { listAllMemories } from "../store-hygiene";
import { type ConsolidationReport, runConsolidation } from "./consolidate";
import { type ContradictionReport, runContradiction } from "./contradict";
import { type ForgettingReport, runForgetting } from "./forget";
import { getHygieneModelConfig } from "./llm";
import { finishHygiene, resetHygieneLock, startHygiene } from "./state";

export interface SweepReport {
  readonly dryRun: boolean;
  readonly skipped?: string;
  readonly model?: string;
  readonly memoryCount?: number;
  readonly consolidation?: ConsolidationReport;
  readonly contradiction?: ContradictionReport;
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

  // Background sweep runs on the root connection (bypasses PERMISSIONS). In
  // slice 2 it scopes to the owner org (sentinel); per-org iteration for a
  // multi-tenant cloud is the MIM-66 fold-in (slice 4).
  const scope = rootScope(await getDb());

  const [err, report] = await attempt(async () => {
    const memories = await listAllMemories(scope);

    const consolidation = await runConsolidation(scope, memories, {
      dryRun,
      mergeDistance: config.hygiene.consolidation.mergeDistance,
      maxClusterSize: config.hygiene.consolidation.maxClusterSize,
      maxMergesPerSweep: config.hygiene.consolidation.maxMergesPerSweep,
    });

    // After a live consolidation the store has changed — re-read so the next
    // pass works on the post-merge set. In dry-run nothing moved.
    const afterConsolidation = dryRun ? memories : await listAllMemories(scope);

    // Contradiction runs in the band ABOVE consolidation's merge distance, so
    // it never touches what consolidation just merged. Disabled → undefined.
    const contradiction = config.hygiene.contradiction.enabled
      ? await runContradiction(scope, afterConsolidation, {
          dryRun,
          mergeDistance: config.hygiene.consolidation.mergeDistance,
          contradictionDistance:
            config.hygiene.contradiction.contradictionDistance,
          maxChecks: config.hygiene.contradiction.maxChecks,
          demotionFactor: config.hygiene.contradiction.demotionFactor,
        })
      : undefined;

    // Re-read again after live demotions so the forgetting pass scores
    // post-demotion confidence — a freshly-superseded fact may now be prunable.
    const forgetMemories = dryRun ? memories : await listAllMemories(scope);

    const forgetting = await runForgetting(scope, forgetMemories, {
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
      contradiction,
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
      demoted: report.contradiction?.demotions.filter((d) => d.applied).length,
      pairMerged: report.contradiction?.merges.filter((m) => m.applied).length,
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
