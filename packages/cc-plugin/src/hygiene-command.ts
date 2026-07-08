/**
 * `mimir-cc hygiene [--live] [--model <id>]` — run the memory hygiene
 * sweep over the LOCAL replica (MIM-86; formerly triggered the server's
 * /v1/hygiene/sweep, which is gone).
 *
 * Dry-run by default; --live applies merges/demotions/prunes. The
 * judgment model is the extraction trio (MIMIR_EXTRACTION_*), --model
 * overriding just the model id. Last-sweep state (drives untouched-decay)
 * lives at ~/.mimir/hygiene-state.json and only advances on live runs.
 */

import { join } from "node:path";
import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import { runLocalHygieneSweep } from "@mimir/plugin-core/brain/hygiene";
import { attempt } from "@mimir/plugin-core/result";
import {
  createOrgReplica,
  defaultOrgReplicaPath,
} from "@mimir/plugin-core/store/org-replica";
import { mimirHome } from "@mimir/plugin-core/util";
import { extractionConfig } from "./config";
import { createLogger } from "./logger";

const log = createLogger("hygiene-command");

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

export const runHygieneCommand = async (args: readonly string[]) => {
  const parsed = parseHygieneArgs(args);
  if ("error" in parsed) {
    console.error(
      `${parsed.error}\nUsage: mimir-cc hygiene [--live] [--model <id>]`,
    );
    return 1;
  }

  const base = await extractionConfig();
  if (!base) {
    console.error(
      "Hygiene needs an extraction endpoint: set MIMIR_EXTRACTION_BASE_URL " +
        "(and MIMIR_EXTRACTION_MODEL or MIMIR_SMALL_MODEL), or the " +
        "config.json extraction fields.",
    );
    return 1;
  }
  const config = parsed.model ? { ...base, model: parsed.model } : base;

  const replica = createOrgReplica(
    process.env.MIMIR_ORG_REPLICA_DB ?? defaultOrgReplicaPath(),
  );
  const lastSweepMs = await readLastSweepMs();

  console.log(
    `Hygiene sweep (${parsed.live ? "LIVE" : "dry-run"}) on ${config.model} — ` +
      `${replica.countMemories()} memories, last sweep ${
        lastSweepMs ? new Date(lastSweepMs).toISOString() : "never"
      }`,
  );

  const report = await runLocalHygieneSweep({
    replica,
    config,
    embed: createEmbedQuery(),
    dryRun: !parsed.live,
    lastSweepMs,
  });
  replica.close();

  if (parsed.live) {
    await Bun.write(statePath(), JSON.stringify({ lastSweepMs: Date.now() }));
  }

  log.info("hygiene sweep complete", {
    live: parsed.live,
    model: report.model,
    clustersFound: report.clustersFound,
    contradictions: report.contradictions.length,
    decayed: report.decayed,
    pruneCandidates: report.pruneCandidates.length,
    pruned: report.pruned,
  });
  console.log(JSON.stringify(report, null, 2));
  return 0;
};
