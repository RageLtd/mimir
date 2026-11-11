/**
 * Tests for `sweepFileContextState`: the file-context hook's per-session
 * state under `<mimirHome()>/file-context-state/` is swept — a session
 * directory older than FILE_CONTEXT_STATE_MAX_AGE_MS goes, with everything
 * under it; the previous layout's flat `<sessionId>.json` files go whatever
 * their age. The sweep resolves to `{ removed, failures }` and never throws.
 *
 * Each test gets its own MIMIR_HOME, so counts are exact and nothing
 * touches the developer's `~/.mimir`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attempt } from "@mimir/plugin-core/result";
import { mimirHome } from "@mimir/plugin-core/util";
import { claimInjection } from "./file-context-hook";
import {
  FILE_CONTEXT_STATE_MAX_AGE_MS,
  sweepFileContextState,
} from "./file-context-sweep";

const STATE_DIR = "file-context-state";
const DAY_MS = 24 * 60 * 60_000;
const MARGIN_MS = 1000;
const HASH = "hash-1";
const FILE = "src/a.ts";
const READ_ONLY = 0o555;
const WRITABLE = 0o755;

const stateDir = () => join(mimirHome(), STATE_DIR);
const freshSession = () => `sess-${crypto.randomUUID()}`;
const sessionDir = (sessionId: string) => join(stateDir(), sessionId);

/** Set a path's modification time to `atMs` (epoch milliseconds). */
const ageTo = (path: string, atMs: number) =>
  utimes(path, atMs / 1000, atMs / 1000);

/** A session in the current layout, with one framed file recorded. */
const recordedSession = async () => {
  const sessionId = freshSession();
  expect(await claimInjection(sessionId, FILE, HASH)).toBe(true);
  return sessionId;
};

/** A previous-layout `<sessionId>.json` file directly under the state directory. */
const flatFile = async () => {
  await mkdir(stateDir(), { recursive: true });
  const path = join(stateDir(), `${freshSession()}.json`);
  await Bun.write(path, JSON.stringify({ "src/a.ts": HASH }));
  return path;
};

const exists = (path: string) => Bun.file(path).exists();

let savedHome: string | undefined;

beforeEach(async () => {
  savedHome = process.env.MIMIR_HOME;
  process.env.MIMIR_HOME = await mkdtemp(join(tmpdir(), "mimir-cc-sweep-"));
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = savedHome;
});

describe("sweepFileContextState", () => {
  test("the age threshold is seven days", () => {
    expect(FILE_CONTEXT_STATE_MAX_AGE_MS).toBe(7 * DAY_MS);
  });

  test("a session directory older than the threshold is removed, with everything under it", async () => {
    const now = Date.now();
    const sessionId = await recordedSession();
    await ageTo(
      sessionDir(sessionId),
      now - FILE_CONTEXT_STATE_MAX_AGE_MS - DAY_MS,
    );

    const result = await sweepFileContextState(now);

    expect(result).toEqual({ removed: 1, failures: [] });
    expect(await readdir(stateDir())).toEqual([]);
  });

  test("a session directory newer than the threshold is kept intact, records included", async () => {
    const now = Date.now();
    const sessionId = await recordedSession();
    const before = await Array.fromAsync(
      new Bun.Glob("**/*").scan({ cwd: sessionDir(sessionId) }),
    );
    await ageTo(sessionDir(sessionId), now - DAY_MS);

    const result = await sweepFileContextState(now);

    expect(result).toEqual({ removed: 0, failures: [] });
    const after = await Array.fromAsync(
      new Bun.Glob("**/*").scan({ cwd: sessionDir(sessionId) }),
    );
    expect(before.length).toBeGreaterThan(0);
    expect(after.sort()).toEqual(before.sort());
  });

  test("the boundary: just under the threshold is kept, just over is removed", async () => {
    const now = Date.now();
    const under = await recordedSession();
    const over = await recordedSession();
    await ageTo(
      sessionDir(under),
      now - FILE_CONTEXT_STATE_MAX_AGE_MS + MARGIN_MS,
    );
    await ageTo(
      sessionDir(over),
      now - FILE_CONTEXT_STATE_MAX_AGE_MS - MARGIN_MS,
    );

    const result = await sweepFileContextState(now);

    expect(result).toEqual({ removed: 1, failures: [] });
    expect(await readdir(stateDir())).toEqual([under]);
  });

  test("previous-layout <sessionId>.json files are removed whatever their age; a fresh session directory stays", async () => {
    const now = Date.now();
    const fresh = await flatFile();
    const old = await flatFile();
    await ageTo(old, now - FILE_CONTEXT_STATE_MAX_AGE_MS - DAY_MS);
    const live = await recordedSession();

    const result = await sweepFileContextState(now);

    expect(result).toEqual({ removed: 2, failures: [] });
    expect(await exists(fresh)).toBe(false);
    expect(await exists(old)).toBe(false);
    expect(await readdir(stateDir())).toEqual([live]);
  });

  test("with no state directory, it does nothing and does not throw", async () => {
    expect(await sweepFileContextState(Date.now())).toEqual({
      removed: 0,
      failures: [],
    });
  });

  test("an entry that cannot be removed does not stop the others, and is reported rather than thrown", async () => {
    const now = Date.now();
    const longAgo = now - FILE_CONTEXT_STATE_MAX_AGE_MS - DAY_MS;
    const stuck = await recordedSession();
    const swept = await recordedSession();
    const flat = await flatFile();
    // A read-only directory inside the session: its file cannot be unlinked.
    const locked = join(sessionDir(stuck), "locked");
    await mkdir(locked);
    await Bun.write(join(locked, "record.json"), JSON.stringify(HASH));
    await chmod(locked, READ_ONLY);
    await ageTo(sessionDir(stuck), longAgo);
    await ageTo(sessionDir(swept), longAgo);

    const [sweepErr, result] = await attempt(() => sweepFileContextState(now));
    await chmod(locked, WRITABLE);

    expect(sweepErr).toBeNull();
    expect(result?.removed).toBe(2);
    expect(result?.failures).toHaveLength(1);
    expect(result?.failures[0]?.path).toBe(sessionDir(stuck));
    expect(typeof result?.failures[0]?.error).toBe("string");
    expect(result?.failures[0]?.error.length).toBeGreaterThan(0);
    expect(await exists(flat)).toBe(false);
    expect(await readdir(stateDir())).toEqual([stuck]);
  });

  test("after a sweep, a kept session still has its file framed and a swept one claims afresh", async () => {
    const now = Date.now();
    const kept = await recordedSession();
    const swept = await recordedSession();
    await ageTo(
      sessionDir(swept),
      now - FILE_CONTEXT_STATE_MAX_AGE_MS - DAY_MS,
    );

    await sweepFileContextState(now);

    expect(await claimInjection(kept, FILE, HASH)).toBe(false);
    expect(await claimInjection(swept, FILE, HASH)).toBe(true);
  });
});
