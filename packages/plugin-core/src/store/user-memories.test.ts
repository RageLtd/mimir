import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserMemoryStore } from "./user-memories";

let root: string;
let savedHome: string | undefined;

beforeEach(async () => {
  savedHome = process.env.HOME;
  root = await mkdtemp(join(tmpdir(), "mimir-user-memory-"));
  process.env.HOME = root;
  await mkdir(join(root, ".mimir"), { recursive: true });
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

const DB_PATH = "~/.mimir/user-memories.db";

const PREFERS_BUNX =
  "Prefers bunx instead of npx for any package-runner command.";
const STRONG_PREFERENCE =
  "Strong preference: use `bunx` not `npx` — will call this out if he sees the wrong one";
const UNRELATED = "Runs the Claude Code CLI in auto permission mode.";

// The user_memories / user_memories_fts schema as it shipped before the
// porter tokenizer: no `tokenize` option on the FTS5 table.
const OLD_SCHEMA = `
CREATE TABLE IF NOT EXISTS user_profile (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS user_memories_fts USING fts5(
  content,
  content='user_memories',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS user_memories_ai AFTER INSERT ON user_memories BEGIN
  INSERT INTO user_memories_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS user_memories_ad AFTER DELETE ON user_memories BEGIN
  INSERT INTO user_memories_fts(user_memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

CREATE TRIGGER IF NOT EXISTS user_memories_au AFTER UPDATE ON user_memories BEGIN
  INSERT INTO user_memories_fts(user_memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO user_memories_fts(rowid, content) VALUES (new.id, new.content);
END;
`;

const contents = (entries: readonly { readonly content: string }[]) =>
  entries.map((entry) => entry.content);

const openSeededStore = (memories: readonly string[]) => {
  const store = createUserMemoryStore(DB_PATH);
  for (const memory of memories) store.addMemory(memory);
  return store;
};

describe("createUserMemoryStore", () => {
  test("opens a home-relative database path without shell expansion", () => {
    const store = createUserMemoryStore(DB_PATH);
    store.addMemory("home-relative path resolved");

    expect(store.getMemories()[0]?.content).toBe("home-relative path resolved");
    store.close();
  });
});

describe("searchMemories", () => {
  test("matches any of a natural-language query's terms", () => {
    const store = openSeededStore([PREFERS_BUNX, STRONG_PREFERENCE, UNRELATED]);

    const found = contents(
      store.searchMemories("bunx package runner preference"),
    );

    expect(found).toContain(PREFERS_BUNX);
    expect(found).toContain(STRONG_PREFERENCE);
    expect(found).not.toContain(UNRELATED);
    store.close();
  });

  test("matches a memory that shares only a stem with the query", () => {
    const store = openSeededStore([PREFERS_BUNX, UNRELATED]);

    expect(contents(store.searchMemories("preference"))).toEqual([
      PREFERS_BUNX,
    ]);
    store.close();
  });

  test("treats a hyphenated query as words, not FTS5 syntax", () => {
    const store = openSeededStore([PREFERS_BUNX, UNRELATED]);

    expect(contents(store.searchMemories("package-runner"))).toEqual([
      PREFERS_BUNX,
    ]);
    store.close();
  });

  test("accepts a query ending in a question mark", () => {
    const store = openSeededStore([PREFERS_BUNX, UNRELATED]);

    expect(
      contents(store.searchMemories("what does he use instead of npx?")),
    ).toContain(PREFERS_BUNX);
    store.close();
  });

  test("accepts a query containing a double quote", () => {
    const store = openSeededStore([PREFERS_BUNX, UNRELATED]);

    expect(contents(store.searchMemories('he said "bunx'))).toEqual([
      PREFERS_BUNX,
    ]);
    store.close();
  });

  test("ranks a memory matching more query terms first", () => {
    const both = "He drinks coffee and tea every morning.";
    const one = "He drinks tea in the evening.";
    const store = openSeededStore([one, both]);

    expect(contents(store.searchMemories("coffee tea"))).toEqual([both, one]);
    store.close();
  });

  test("returns nothing for an empty or whitespace-only query", () => {
    const store = openSeededStore([PREFERS_BUNX]);

    expect(store.searchMemories("")).toEqual([]);
    expect(store.searchMemories("   \t\n")).toEqual([]);
    store.close();
  });
});

describe("migrating a database created with the unstemmed FTS schema", () => {
  const seedOldDatabase = (memories: readonly string[]) => {
    const db = new Database(join(root, ".mimir", "user-memories.db"));
    db.run(OLD_SCHEMA);
    const insert = db.query("INSERT INTO user_memories (content) VALUES (?)");
    for (const memory of memories) insert.run(memory);
    db.close();
  };

  test("keeps every row and stem-matches the pre-existing rows", () => {
    seedOldDatabase([PREFERS_BUNX, UNRELATED]);

    const store = createUserMemoryStore(DB_PATH);

    expect(contents(store.getMemories()).sort()).toEqual(
      [PREFERS_BUNX, UNRELATED].sort(),
    );
    expect(contents(store.searchMemories("preference"))).toEqual([
      PREFERS_BUNX,
    ]);
    store.close();
  });

  test("reopening a migrated database neither loses nor duplicates rows", () => {
    seedOldDatabase([PREFERS_BUNX, UNRELATED]);

    createUserMemoryStore(DB_PATH).close();
    const store = createUserMemoryStore(DB_PATH);

    expect(contents(store.getMemories()).sort()).toEqual(
      [PREFERS_BUNX, UNRELATED].sort(),
    );
    expect(contents(store.searchMemories("preference"))).toEqual([
      PREFERS_BUNX,
    ]);
    store.close();
  });
});
