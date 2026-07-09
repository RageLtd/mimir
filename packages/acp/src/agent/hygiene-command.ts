/**
 * `/hygiene [model] [--live]` — memory hygiene over the LOCAL replica
 * (MIM-89; the stub era ended with the inversion). Dry-run by default;
 * --live applies merges/demotions/prunes. The judgment model is the
 * extraction trio (MIMIR_EXTRACTION_*), with the command's model arg
 * overriding just the model id.
 *
 * Last-sweep state (drives untouched-decay) is SHARED with the cc/oc
 * plugins at ~/.mimir/hygiene-state.json — all three sweep the same
 * replica, so the decay clock must be one clock. It advances only on
 * live runs.
 */

import { join } from "node:path";
import { runLocalHygieneSweep } from "@mimir/plugin-core/brain/hygiene";
import { attempt } from "@mimir/plugin-core/result";
import { mimirHome } from "@mimir/plugin-core/util";
import { extractionConfig } from "../config";
import { createChildLogger, log } from "../utils/log";
import { sharedEmbedQuery } from "./brain";
import type { CommandDeps } from "./commands";
import { emitAgentText } from "./lifecycle-helpers";

const logger = createChildLogger(log, "hygiene");

const END_TURN = { stopReason: "end_turn" as const };

const statePath = () => join(mimirHome(), "hygiene-state.json");

const readLastSweepMs = async () => {
  const file = Bun.file(statePath());
  if (!(await file.exists())) return null;
  const [err, parsed] = await attempt(
    async () => (await file.json()) as { lastSweepMs?: number },
  );
  if (err || typeof parsed.lastSweepMs !== "number") return null;
  return parsed.lastSweepMs;
};

type SweepReport = Awaited<ReturnType<typeof runLocalHygieneSweep>>;

const formatReport = (report: SweepReport, live: boolean) => {
  const lines: string[] = [
    `**Hygiene sweep** (${live ? "LIVE" : "dry-run"})`,
    "",
    `- Merge clusters: ${report.proposals.length}`,
    `- Contradictions checked: ${report.contradictions.length}`,
    `- Prune candidates: ${report.pruneCandidates.length}`,
    `- Decayed: ${report.decayed} · Pruned: ${report.pruned}`,
  ];
  for (const p of report.proposals) {
    lines.push(
      `  - [${p.applied ? "applied" : "proposed"}] merge ${p.members.length} → ${
        p.merged ? `"${p.merged.slice(0, 120)}"` : "(no merge text)"
      }`,
    );
  }
  if (!live) {
    lines.push("", "Run `/hygiene --live` to apply.");
  }
  return lines.join("\n");
};

export const runHygiene = async (
  deps: CommandDeps,
  sessionId: string,
  opts: { modelId: string | undefined; live: boolean },
) => {
  const base = extractionConfig();
  if (!base) {
    await emitAgentText(
      deps.conn,
      sessionId,
      "Hygiene needs an extraction endpoint: set `MIMIR_EXTRACTION_BASE_URL` " +
        "(and `MIMIR_EXTRACTION_MODEL` or `MIMIR_SMALL_MODEL`) in the " +
        "editor's env block.",
    );
    return END_TURN;
  }
  if (!deps.replica) {
    await emitAgentText(deps.conn, sessionId, "Local replica unavailable.");
    return END_TURN;
  }
  const config = opts.modelId ? { ...base, model: opts.modelId } : base;
  const lastSweepMs = await readLastSweepMs();

  await emitAgentText(
    deps.conn,
    sessionId,
    `Hygiene sweep (${opts.live ? "LIVE" : "dry-run"}) on \`${config.model}\` — ` +
      `${deps.replica.countMemories()} memories, last sweep ${
        lastSweepMs ? new Date(lastSweepMs).toISOString() : "never"
      }…`,
  );

  const report = await runLocalHygieneSweep({
    replica: deps.replica,
    config,
    embed: sharedEmbedQuery(),
    dryRun: !opts.live,
    lastSweepMs,
  });

  if (opts.live) {
    await Bun.write(statePath(), JSON.stringify({ lastSweepMs: Date.now() }));
  }

  logger.info("hygiene sweep complete", {
    live: opts.live,
    proposals: report.proposals.length,
    contradictions: report.contradictions.length,
    decayed: report.decayed,
    pruned: report.pruned,
  });

  await emitAgentText(deps.conn, sessionId, formatReport(report, opts.live));
  return END_TURN;
};
