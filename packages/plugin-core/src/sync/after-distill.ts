/**
 * Push leg (MIM-88) after a distillation: ship what was just stored
 * through the blind sync relay. Every host runs it from a hook process
 * that exits right after, or beside a turn it must not hold, so it is
 * bounded: a missed deadline leaves the rows dirty for the next boot or
 * distillation to push. Never throws — a failed sync costs nothing that
 * was distilled.
 */

import type { Logger } from "../logger";
import { attempt } from "../result";
import { syncFromSharedConfig } from "./cli";

const SYNC_DEADLINE_MS = 10_000;

export const syncAfterDistill = async (
  log: Pick<Logger, "info" | "warn">,
  ops: {
    readonly sync: () => Promise<object>;
    readonly deadlineMs: number;
  } = { sync: syncFromSharedConfig, deadlineMs: SYNC_DEADLINE_MS },
) => {
  const [syncErr, synced] = await attempt(() =>
    Promise.race([
      ops.sync(),
      new Promise<{ status: "deadline" }>((resolve) =>
        setTimeout(() => resolve({ status: "deadline" }), ops.deadlineMs),
      ),
    ]),
  );
  if (syncErr) {
    log.warn("post-distill sync failed", { error: syncErr.message });
  } else {
    log.info("post-distill sync", { ...synced });
  }
};
