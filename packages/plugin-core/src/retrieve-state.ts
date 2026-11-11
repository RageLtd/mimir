/**
 * What retrieval has already put into a session's context window
 * (MIM-147). A row is injected once: the retrieve hook skips these ids on
 * later prompts, and the list is emptied when a compaction replaces the
 * window that held them.
 *
 * Lives in `~/.mimir/retrieve-state/<session-id>.json`. Codex keeps its
 * first-prompt marker in the same file, so writes merge into whatever is
 * there and a clear empties the list instead of deleting the file.
 */

import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { attempt } from "./result";
import { mimirHome } from "./util";

/** A session id becomes a file name; anything else could leave the folder. */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;
const SHOWN_ID_CHARS = 40;

const statePath = (sessionId: string) => {
  if (!SAFE_SESSION_ID.test(sessionId)) {
    throw new Error(
      `session id "${sessionId.slice(0, SHOWN_ID_CHARS)}" cannot name a retrieve-state file`,
    );
  }
  return join(mimirHome(), "retrieve-state", `${sessionId}.json`);
};

const readState = async (path: string) => {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  // Serialisation boundary: our own JSON, read back.
  const parsed = (await file.json()) as unknown;
  return parsed !== null && typeof parsed === "object" ? { ...parsed } : {};
};

/** A file that cannot be parsed is replaced, not kept: the next write
 *  would otherwise fail for the rest of the session. */
const readStateForWrite = async (path: string) => {
  const [err, state] = await attempt(() => readState(path));
  return err ? {} : state;
};

/** Written beside the file and renamed over it, so a reader never sees
 *  half a write. */
const writeState = async (path: string, state: object) => {
  await mkdir(dirname(path), { recursive: true });
  const partial = `${path}.${process.pid}.tmp`;
  await Bun.write(partial, JSON.stringify(state));
  await rename(partial, path);
};

const injectedOf = (state: object) =>
  "injected" in state && Array.isArray(state.injected)
    ? state.injected.filter((id) => typeof id === "string")
    : [];

/** Ids already injected this session. Rejects for a session id that
 *  cannot name a file, or a state file that cannot be parsed. */
export const readInjectedIds = async (sessionId: string) =>
  new Set<string>(injectedOf(await readState(statePath(sessionId))));

/** Add ids to the session's list. */
export const recordInjectedIds = async (
  sessionId: string,
  ids: readonly string[],
) => {
  const path = statePath(sessionId);
  if (ids.length === 0) return;
  const state = await readStateForWrite(path);
  await writeState(path, {
    ...state,
    injected: [...new Set([...injectedOf(state), ...ids])],
  });
};

/** Empty the session's list; the window that held those rows is gone. */
export const clearInjectedIds = async (sessionId: string) => {
  const path = statePath(sessionId);
  if (!(await Bun.file(path).exists())) return;
  const state = await readStateForWrite(path);
  await writeState(path, { ...state, injected: [] });
};
