/**
 * Hygiene sweep lock — one row PER ORG (MIM-66) guarding that org's memory
 * hygiene sweep so two never overlap, while different tenants sweep freely in
 * parallel.
 *
 * Mirrors the compaction lock (agent/message-log/compaction-state.ts):
 *   - atomic acquire via UPDATE ... WHERE is_running = false
 *   - finish resets the flag and stamps last_run
 *   - clearStaleHygiene recovers a lock left stuck by a crash mid-sweep
 */

import { RecordId } from "surrealdb";
import { getDb, queryFirst, queryOne } from "../../db/surreal";
import { log } from "../../util/logger";

export interface HygieneState {
  id: string;
  is_running: boolean;
  last_run?: string;
  updated_at: string;
}

/** An org's hygiene-state record id, bound as a query param. NEVER inline a
 *  `type::thing(...)` call in statement text instead — the function was
 *  removed in SurrealDB 3.x and every statement position rejects it with a
 *  parse error (caught live by the MIM-75 smoke). */
const lockId = (orgId: string) => new RecordId("hygiene_state", orgId);

/** Read an org's hygiene state, or null if no sweep has ever run for it. */
export async function getHygieneState(orgId: string) {
  return queryFirst<HygieneState>("SELECT * FROM $lock", {
    lock: lockId(orgId),
  });
}

/**
 * Acquire an org's sweep lock. Returns true if acquired, false if that org's
 * sweep is already running. Atomic: only flips is_running false → true.
 */
export async function startHygiene(orgId: string) {
  const db = await getDb();

  await db.query(
    "INSERT IGNORE INTO hygiene_state { id: $lock, org_id: $org, is_running: false }",
    { lock: lockId(orgId), org: orgId },
  );

  const result = await queryOne<HygieneState>(
    "UPDATE $lock SET is_running = true, updated_at = time::now() WHERE is_running = false",
    { lock: lockId(orgId) },
  );

  const acquired = result.length > 0;
  log.info({ acquired, orgId }, "hygiene lock acquisition");
  return acquired;
}

/**
 * Unconditionally clear EVERY org's lock. Called at boot: a freshly-started
 * process means no sweep is in flight (single-instance server), so any
 * lingering is_running=true is from a process killed mid-sweep — e.g. a
 * redeploy during a long sweep. Time-gating that (clearStaleHygiene) would
 * block manual sweeps for the whole stale window after every such restart.
 */
export async function resetHygieneLock() {
  const db = await getDb();
  await db.query(
    `UPDATE hygiene_state SET is_running = false, updated_at = time::now()`,
  );
  log.info("hygiene locks reset on boot");
}

/** Release an org's lock and stamp its completion time. */
export async function finishHygiene(orgId: string) {
  const db = await getDb();
  await db.query(
    `UPDATE $lock SET
      is_running = false,
      last_run = time::now(),
      updated_at = time::now()`,
    { lock: lockId(orgId) },
  );
  log.debug({ orgId }, "hygiene lock released");
}

/**
 * Clear stale locks across EVERY org. If is_running has been true longer than
 * staleMinutes the sweep that held it was interrupted (crash, kill) and the
 * lock is dead.
 *
 * Call at server boot, alongside clearStaleCompaction.
 */
export async function clearStaleHygiene(staleMinutes: number = 30) {
  const result = await queryOne<HygieneState>(
    `UPDATE hygiene_state
     SET is_running = false, updated_at = time::now()
     WHERE is_running = true AND updated_at < time::now() - ${staleMinutes}m
     RETURN AFTER`,
  );

  const cleared = result.length > 0;
  if (cleared) {
    log.info(
      { staleMinutes, count: result.length },
      "cleared stale hygiene locks",
    );
  }
  return cleared;
}
