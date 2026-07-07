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
import type { HygieneByok } from "../goldfish/hygiene/llm";
import { type IdentityEnv, scopeOrgId } from "../middleware/identity";
import {
  extractProviderOverride,
  PROVIDER_KEY_HEADER,
} from "../middleware/pipeline";
import { requestLog } from "../util/logger";
import { attempt } from "../util/result";

export const hygiene = new Hono<IdentityEnv>();

type SweepRequest = {
  /** Omitted → dry run. Only an explicit false arms the destructive pass. */
  dryRun?: boolean;
  /** BYOK hints (MIM-75): non-secret routing info rides the body, the key
   *  rides the X-Provider-Api-Key header — same split as /persist. */
  provider?: string;
  base_url?: string;
  /** The judgment model a keyed sweep runs on. REQUIRED with a key — hygiene
   *  refuses to guess its model, mirroring the env HYGIENE_MODEL refusal. */
  model?: string;
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

  // BYOK (MIM-75 Part 1): a keyed trigger runs the sweep's model calls on the
  // caller's key. Transient — the override lives for this sweep only. A key
  // without a named model is refused rather than guessed at or silently
  // billed to the operator (MIM-74's hard rule).
  const override = extractProviderOverride(c.req.header(PROVIDER_KEY_HEADER), {
    provider: body.provider,
    base_url: body.base_url,
  });
  let byok: HygieneByok | null = null;
  if (override) {
    if (!body.model) {
      return c.json(
        {
          error:
            "model is required when a provider key is sent — name the judgment model the sweep should run on",
        },
        400,
      );
    }
    byok = { override, modelId: body.model };
  }

  // Manual sweep scopes to the caller's org (owner sentinel when auth is off).
  const [err, report] = await attempt(() =>
    runHygieneSweep(scopeOrgId(c), { dryRun, byok }),
  );
  if (err) {
    log.error({ error: err.message }, "hygiene sweep failed");
    return c.json({ error: err.message }, 500);
  }
  return c.json(report);
});
