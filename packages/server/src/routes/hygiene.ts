/**
 * Hygiene Routes
 *
 *   POST /v1/hygiene/sweep — run a memory hygiene sweep on demand and return
 *                            the structured report. Defaults to dry-run so a
 *                            bare curl never mutates the store; pass
 *                            { "dryRun": false } to arm it.
 *
 * The dry-run report carries the model-written canonical text for every
 * proposed merge and the score/age/reason for every proposed prune — enough to
 * tune thresholds against a real store before letting the sweep cut.
 */

import { Hono } from "hono";
import { runHygieneSweep } from "../goldfish/hygiene";
import { requestLog } from "../util/logger";
import { attempt } from "../util/result";

export const hygiene = new Hono();

type SweepRequest = {
  /** Omitted → dry run. Only an explicit false arms the destructive pass. */
  dryRun?: boolean;
};

hygiene.post("/sweep", async (c) => {
  const rid = c.req.header("x-request-id") ?? "hygiene";
  const log = requestLog(rid);

  // Empty body is valid (bare curl) → dry run.
  let body: SweepRequest = {};
  const raw = await c.req.text();
  if (raw.trim()) {
    try {
      body = JSON.parse(raw);
    } catch (err) {
      log.debug(
        { err: err instanceof Error ? err.message : String(err) },
        "invalid JSON body",
      );
      return c.json({ error: "Invalid JSON body" }, 400);
    }
  }

  const dryRun = body.dryRun !== false;

  const [err, report] = await attempt(() => runHygieneSweep({ dryRun }));
  if (err) {
    log.error({ error: err.message }, "hygiene sweep failed");
    return c.json({ error: err.message }, 500);
  }
  return c.json(report);
});
