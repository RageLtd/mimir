/**
 * `/hygiene [model] [--live]` — trigger a server-side memory hygiene sweep
 * (MIM-75 Part 1). In cloud mode the periodic scheduler is off
 * (triggered-only), so this is the deliberate way to run one. Dry-run unless
 * `--live`. When the user has a provider key configured for the judgment
 * model, the sweep runs on their key — the model rides the body, the key
 * rides the header, matching the server's transport split.
 *
 * Lives in its own module (not commands.ts) — it is the only command that
 * makes its own HTTP call, and commands.ts sits at the file-length limit.
 */

import { attempt } from "@mimir/plugin-core/result";
import { config } from "../config";
import { PROVIDER_KEY_HEADER, providerKeyForModel } from "../server-client";
import type { CommandDeps } from "./commands";
import { emitAgentText } from "./lifecycle-helpers";

/** Sweeps chain multiple judgment-model calls — allow them plenty of time. */
const HYGIENE_SWEEP_TIMEOUT_MS = 600_000;

const END_TURN = { stopReason: "end_turn" as const };

/** The server's SweepReport, loosely typed at this serialisation boundary. */
type SweepReport = {
  readonly dryRun?: boolean;
  readonly skipped?: string;
  readonly model?: string;
  readonly memoryCount?: number;
  readonly consolidation?: { merged?: number; clustersFound?: number };
  readonly contradiction?: {
    demotions?: { applied?: boolean }[];
    merges?: { applied?: boolean }[];
  };
  readonly forgetting?: { prunedCount?: number; decayedCount?: number };
  readonly elapsedMs?: number;
};

const postSweep = async (headers: Record<string, string>, body: unknown) => {
  const response = await fetch(`${config.serverUrl}/v1/hygiene/sweep`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HYGIENE_SWEEP_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "unknown error");
    throw new Error(`server returned ${response.status}: ${text}`);
  }
  return (await response.json()) as SweepReport;
};

export const formatSweepReport = (report: SweepReport) => {
  if (report.skipped) return `Hygiene sweep skipped: ${report.skipped}`;
  const demoted =
    report.contradiction?.demotions?.filter((d) => d.applied).length ?? 0;
  const pairMerged =
    report.contradiction?.merges?.filter((m) => m.applied).length ?? 0;
  const lines = [
    `Hygiene sweep ${report.dryRun ? "dry run" : "LIVE run"} complete (model \`${report.model ?? "?"}\`, ${report.memoryCount ?? 0} memories, ${Math.round((report.elapsedMs ?? 0) / 1000)}s).`,
    `- Consolidation: ${report.consolidation?.clustersFound ?? 0} cluster(s) found, ${report.consolidation?.merged ?? 0} merged`,
    `- Contradiction: ${demoted} demoted, ${pairMerged} pair-merged`,
    `- Forgetting: ${report.forgetting?.prunedCount ?? 0} pruned, ${report.forgetting?.decayedCount ?? 0} decayed`,
  ];
  if (report.dryRun) {
    lines.push("Nothing was mutated — pass `--live` to apply.");
  }
  return lines.join("\n");
};

export const runHygiene = async (
  deps: CommandDeps,
  sessionId: string,
  opts: { modelId: string | undefined; live: boolean },
) => {
  const session = deps.core.getSession(sessionId);
  if (!session) {
    await emitAgentText(deps.conn, sessionId, "Session not found.");
    return END_TURN;
  }

  const model = opts.modelId ?? session.currentModelId;
  const providerKey = providerKeyForModel(model);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    ...(providerKey ? { [PROVIDER_KEY_HEADER]: providerKey } : {}),
  };
  // The server requires a named judgment model with a key and ignores it
  // without one (env HYGIENE_MODEL serves the keyless path).
  const body = {
    dryRun: !opts.live,
    ...(providerKey ? { model } : {}),
  };

  await emitAgentText(
    deps.conn,
    sessionId,
    `Running memory hygiene sweep (${opts.live ? "LIVE" : "dry run"}${providerKey ? `, model \`${model}\` on your key` : ", server-configured model"}) — this can take a few minutes.`,
  );

  const [err, report] = await attempt(() => postSweep(headers, body));
  if (err) {
    await emitAgentText(
      deps.conn,
      sessionId,
      `Hygiene sweep failed: ${err.message}`,
    );
    return END_TURN;
  }
  await emitAgentText(deps.conn, sessionId, formatSweepReport(report));
  return END_TURN;
};
