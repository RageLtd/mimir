/**
 * Where the binary keeps the session journal, and how long a session's
 * journal outlives its last write: the session-start worker prunes those
 * idle past `SESSION_JOURNAL_MAX_IDLE_DAYS`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionJournal,
  defaultSessionJournalPath,
} from "@mimir/plugin-core/store/session-journal";
import {
  SESSION_JOURNAL_MAX_IDLE_DAYS,
  sessionJournalPath,
} from "./session-journal";
import { runWorker } from "./session-start-hook";

const JOURNAL_ENV = "MIMIR_SESSION_JOURNAL_DB";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const STALE = "session-stale";
const FRESH = "session-fresh";
const MESSAGES = [{ role: "user", content: [{ type: "text", text: "hello" }] }];

let dir = "";
let savedEnv: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mimir-session-journal-"));
  savedEnv = process.env[JOURNAL_ENV];
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env[JOURNAL_ENV];
  else process.env[JOURNAL_ENV] = savedEnv;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

describe("sessionJournalPath", () => {
  test("is MIMIR_SESSION_JOURNAL_DB when that is set", () => {
    const path = join(dir, "elsewhere.db");
    process.env[JOURNAL_ENV] = path;
    expect(sessionJournalPath()).toBe(path);
  });

  test("is the store's default path otherwise", () => {
    delete process.env[JOURNAL_ENV];
    expect(sessionJournalPath()).toBe(defaultSessionJournalPath());
  });
});

describe("the session-start worker prunes idle journals", () => {
  test("a session idle past the limit is pruned; a fresher one is kept", async () => {
    expect(SESSION_JOURNAL_MAX_IDLE_DAYS).toBeGreaterThan(0);
    const path = join(dir, "session-journal.db");
    process.env[JOURNAL_ENV] = path;
    const limitMs = SESSION_JOURNAL_MAX_IDLE_DAYS * DAY_MS;

    const stale = createSessionJournal(path, {
      now: () => Date.now() - limitMs - HOUR_MS,
    });
    stale.append(STALE, MESSAGES);
    stale.close();
    const fresh = createSessionJournal(path, {
      now: () => Date.now() - limitMs + HOUR_MS,
    });
    fresh.append(FRESH, MESSAGES);
    fresh.close();

    const code = await runWorker("/work/repo", {
      reconcileAndSync: async () => ({ status: "ok" }),
      reindex: async () => {},
    });
    expect(code).toBe(0);

    const journal = createSessionJournal(path);
    expect(journal.readUncovered(STALE).messages).toEqual([]);
    expect(journal.readUncovered(FRESH).messages).toEqual(MESSAGES);
    journal.close();
  });

  test("a journal that cannot be opened does not stop the reindex", async () => {
    process.env[JOURNAL_ENV] = join(dir, "missing-dir", "nested", "x.db");
    let reindexed = false;
    const code = await runWorker("/work/repo", {
      reconcileAndSync: async () => ({ status: "ok" }),
      reindex: async () => {
        reindexed = true;
      },
    });
    expect(code).toBe(0);
    expect(reindexed).toBe(true);
  });
});
