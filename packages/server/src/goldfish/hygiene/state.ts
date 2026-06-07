/**
 * Hygiene sweep lock — a single global row guarding the periodic memory
 * hygiene sweep so two never overlap.
 *
 * Mirrors the compaction lock (agent-loop/message-log/compaction-state.ts):
 *   - atomic acquire via UPDATE ... WHERE is_running = false
 *   - finish resets the flag and stamps last_run
 *   - clearStaleHygiene recovers a lock left stuck by a crash mid-sweep
 */

import { getDb, queryFirst, queryOne } from "../../db/surreal";
import { log } from "../../util/logger";

export interface HygieneState {
  id: string;
  is_running: boolean;
  last_run?: string;
  updated_at: string;
}

const STATE_ID = "hygiene_state:global";

/** Read the global hygiene state, or null if no sweep has ever run. */
export async function getHygieneState(): Promise<HygieneState | null> {
  return queryFirst<HygieneState>(`SELECT * FROM ${STATE_ID}`);
}

/**
 * Acquire the sweep lock. Returns true if acquired, false if a sweep is
 * already running. Atomic: only flips is_running false → true.
 */
export async function startHygiene(): Promise<boolean> {
  const db = await getDb();

  await db.query(
    `INSERT IGNORE INTO hygiene_state { id: ${STATE_ID}, is_running: false }`,
  );

  const result = await queryOne<HygieneState>(
    `UPDATE ${STATE_ID} SET is_running = true, updated_at = time::now() WHERE is_running = false`,
  );

  const acquired = result.length > 0;
  log.info({ acquired }, "hygiene lock acquisition");
  return acquired;
}

/**
 * Unconditionally clear the lock. Called at boot: a freshly-started process
 * means no sweep is in flight (single-instance server), so any lingering
 * is_running=true is from a process killed mid-sweep — e.g. a redeploy during
 * a long sweep. Time-gating that (clearStaleHygiene) would block manual sweeps
 * for the whole stale window after every such restart.
 */
export async function resetHygieneLock() {
  const db = await getDb();
  await db.query(
    `INSERT IGNORE INTO hygiene_state { id: ${STATE_ID}, is_running: false }`,
  );
  await db.query(
    `UPDATE ${STATE_ID} SET is_running = false, updated_at = time::now()`,
  );
  log.info("hygiene lock reset on boot");
}

/** Release the lock and stamp the completion time. */
export async function finishHygiene(): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE ${STATE_ID} SET
      is_running = false,
      last_run = time::now(),
      updated_at = time::now()`,
  );
  log.debug("hygiene lock released");
}

/**
 * Clear a stale lock. If is_running has been true longer than staleMinutes the
 * sweep that held it was interrupted (crash, kill) and the lock is dead.
 *
 * Call at server boot, alongside clearStaleCompaction.
 */
export async function clearStaleHygiene(
  staleMinutes: number = 30,
): Promise<boolean> {
  const result = await queryOne<HygieneState>(
    `UPDATE ${STATE_ID}
     SET is_running = false, updated_at = time::now()
     WHERE is_running = true AND updated_at < time::now() - ${staleMinutes}m
     RETURN AFTER`,
  );

  const cleared = result.length > 0;
  if (cleared) {
    log.info({ staleMinutes }, "cleared stale hygiene lock");
  }
  return cleared;
}
