/**
 * Boot reconcile-then-sync, bounded.
 *
 * Silent key reconcile (fulfil pending wraps) must finish before the org
 * sync starts, since the sync needs the keys it hands out. The pair runs
 * under a deadline because hosts queue other boot work behind it and a
 * hung request would otherwise hold that work forever; a miss resolves
 * `{ status: "deadline" }` and retries next session. Once the deadline
 * passes, a late reconcile does not go on to start a sync.
 *
 * A rejecting reconcile or sync rejects the call — the host decides how
 * to report it.
 */

import type { Logger } from "../logger";

const DEADLINE = { status: "deadline" } as const;

export const reconcileAndSync = async <S>(
  input: { readonly log: Logger; readonly deadlineMs: number },
  deps: {
    readonly reconcile: () => Promise<object>;
    readonly sync: () => Promise<S>;
  },
) => {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve(DEADLINE);
    }, input.deadlineMs);
  });

  const run = async () => {
    const keys = await deps.reconcile();
    input.log.info("key reconcile", { ...keys });
    if (expired) return DEADLINE;
    return deps.sync();
  };

  return Promise.race([run(), deadline]).finally(() => clearTimeout(timer));
};
