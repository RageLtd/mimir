/**
 * The worker's hand-back protocol. A worker ends its turn with a
 * `STATUS:` line; the gate only runs for `done`. `question` and
 * `blocked` go straight to the coordinator; `failed` is what the gate
 * itself appends when the loop guard gives up.
 */

export type WorkerStatus = "done" | "blocked" | "question" | "failed";

const STATUS_LINE = /^\s*STATUS:\s*(done|blocked|question|failed)\b/gim;

/** The last STATUS line in the message, or null when there is none. */
export const parseStatus = (message: string) => {
  let last: WorkerStatus | null = null;
  for (const match of message.matchAll(STATUS_LINE)) {
    const value = match[1]?.toLowerCase();
    if (
      value === "done" ||
      value === "blocked" ||
      value === "question" ||
      value === "failed"
    ) {
      last = value;
    }
  }
  return last;
};
