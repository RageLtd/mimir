/**
 * Whether a project's session summary is still being written. An ending
 * session marks its project in flight — the `session-end` runner when it
 * knows the project id, its worker otherwise — until the worker is done.
 * The next session's first retrieve (`mimir-cc retrieve`) reads it to tell
 * a summary is still coming rather than settling for an older one. While
 * the mark is live the summary stays owed whatever the distance gate
 * admitted — the newest-summary fallback is withheld, a summary near the
 * prompt is still injected — and the session asks again on its next prompt
 * until the mark clears or goes stale. A failed or unreadable retrieve
 * leaves it owed too.
 *
 * A mark is owned: marking returns a token, and only that token clears it.
 * A newer mark takes ownership, so a worker that finishes late cannot clear
 * the mark of one still running.
 *
 * Lives in `~/.mimir/summary-pending/<hex of the project id>.json` as
 * `{ at, owner }`. A mark older than SUMMARY_PENDING_STALE_MS outlived its
 * worker and reads as not pending; so does one that cannot be parsed.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { attempt } from "./result";
import { mimirHome } from "./util";

/** Past a summary's own bound (120 s) with room to spare. */
export const SUMMARY_PENDING_STALE_MS = 5 * 60_000;

/** Hex keeps any project id — `:`, `/`, `..` and all — one plain file name. */
const markPath = (projectId: string) =>
  join(
    mimirHome(),
    "summary-pending",
    `${Buffer.from(projectId, "utf8").toString("hex")}.json`,
  );

const readMark = async (path: string) => {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  // Serialisation boundary: our own JSON, read back.
  const parsed = (await file.json()) as unknown;
  return parsed !== null &&
    typeof parsed === "object" &&
    "at" in parsed &&
    typeof parsed.at === "number" &&
    "owner" in parsed &&
    typeof parsed.owner === "string"
    ? { at: parsed.at, owner: parsed.owner }
    : null;
};

/**
 * Mark the project's summary in flight as of `now`; resolves to the owner
 * token that clears it.
 */
export const markSummaryPending = async (
  projectId: string,
  now = Date.now(),
) => {
  const path = markPath(projectId);
  const owner = randomUUID();
  await mkdir(dirname(path), { recursive: true });
  // Written beside the file and renamed over it: a reader never sees half.
  const partial = `${path}.${owner}.tmp`;
  await Bun.write(partial, JSON.stringify({ at: now, owner }));
  await rename(partial, path);
  return owner;
};

/**
 * Clear the mark if `token` still owns it. Another owner's mark, a missing
 * one, or one that cannot be parsed is left as it is, without an error.
 */
export const clearSummaryPending = async (projectId: string, token: string) => {
  const path = markPath(projectId);
  const [err, mark] = await attempt(() => readMark(path));
  if (err || mark?.owner !== token) return;
  await rm(path, { force: true });
};

/** Whether a fresh mark stands; a corrupt mark reads as none. */
export const isSummaryPending = async (projectId: string, now = Date.now()) => {
  const [err, mark] = await attempt(() => readMark(markPath(projectId)));
  if (err || mark === null) return false;
  return now - mark.at < SUMMARY_PENDING_STALE_MS;
};
