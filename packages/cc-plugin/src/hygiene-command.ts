/**
 * `mimir-cc hygiene [--live] [--model <id>]` — trigger a server-side memory
 * hygiene sweep (MIM-75 Part 1). In cloud mode the periodic scheduler is off
 * (triggered-only); this subcommand is the deliberate trigger. Dry-run
 * unless --live.
 *
 * Credentials never enter the model transcript: this process reads the
 * MIMIR_API_KEY / MIMIR_PROVIDER_API_KEY env (or config.json) itself and
 * sends the provider key in the X-Provider-Api-Key header, mirroring the
 * transcript-delta shipper (MIM-74). A keyed sweep must name its judgment
 * model — --model wins, the configured small model is the fallback.
 */

import { attempt } from "@mimir/plugin-core/result";
import { authHeaders, providerByok, readConfig } from "./config";

/** Mirrors PROVIDER_KEY_HEADER on the server (middleware/pipeline.ts). */
const PROVIDER_KEY_HEADER = "X-Provider-Api-Key";

/** Sweeps chain multiple judgment-model calls — allow them plenty of time. */
const HYGIENE_SWEEP_TIMEOUT_MS = 600_000;

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

export const parseHygieneArgs = (args: readonly string[]) => {
  let live = false;
  let model: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--live") {
      live = true;
    } else if (arg === "--model") {
      model = args[i + 1];
      i++;
    } else {
      return { error: `Unknown argument: ${arg}` };
    }
  }
  return { live, model };
};

export const formatSweepReport = (report: SweepReport) => {
  if (report.skipped) return `Hygiene sweep skipped: ${report.skipped}`;
  const demoted =
    report.contradiction?.demotions?.filter((d) => d.applied).length ?? 0;
  const pairMerged =
    report.contradiction?.merges?.filter((m) => m.applied).length ?? 0;
  const lines = [
    `Hygiene sweep ${report.dryRun ? "dry run" : "LIVE run"} complete (model ${report.model ?? "?"}, ${report.memoryCount ?? 0} memories, ${Math.round((report.elapsedMs ?? 0) / 1000)}s).`,
    `- Consolidation: ${report.consolidation?.clustersFound ?? 0} cluster(s) found, ${report.consolidation?.merged ?? 0} merged`,
    `- Contradiction: ${demoted} demoted, ${pairMerged} pair-merged`,
    `- Forgetting: ${report.forgetting?.prunedCount ?? 0} pruned, ${report.forgetting?.decayedCount ?? 0} decayed`,
  ];
  if (report.dryRun) {
    lines.push("Nothing was mutated — pass --live to apply.");
  }
  return lines.join("\n");
};

export const runHygieneCommand = async (args: readonly string[]) => {
  const parsed = parseHygieneArgs(args);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 1;
  }

  const config = await readConfig();
  if (!config?.serverUrl) {
    console.error("Mimir is not installed — run the installer first.");
    return 1;
  }

  const byok = await providerByok();
  const model = parsed.model ?? byok?.smallModel;
  if (byok && !model) {
    console.error(
      "A provider key is configured but no model is named — pass --model <id> (or set MIMIR_SMALL_MODEL).",
    );
    return 1;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(await authHeaders()),
  };
  if (byok) headers[PROVIDER_KEY_HEADER] = byok.apiKey;

  const body = {
    dryRun: !parsed.live,
    ...(byok
      ? { model, ...(byok.provider ? { provider: byok.provider } : {}) }
      : {}),
  };

  console.log(
    `Running memory hygiene sweep (${parsed.live ? "LIVE" : "dry run"}${byok ? `, model ${model} on your key` : ", server-configured model"}) — this can take a few minutes.`,
  );

  const [err, report] = await attempt(async () => {
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
  });

  if (err) {
    console.error(`Hygiene sweep failed: ${err.message}`);
    return 1;
  }
  console.log(formatSweepReport(report));
  return 0;
};
