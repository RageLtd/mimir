import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  createSessionJournal,
  defaultSessionJournalPath,
} from "./session-journal";

const SESSION_A = "session-a";
const SESSION_B = "session-b";
const MINUTE_MS = 60_000;

const user = (text: string) => ({
  role: "user",
  content: [{ type: "text", text }],
});
const assistant = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

const a = user("a");
const b = assistant("b");
const c = user("c");
const d = assistant("d");
const e = user("e");

let root: string;
let clock: number;
let journal: ReturnType<typeof createSessionJournal>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mimir-session-journal-"));
  clock = Date.UTC(2026, 10, 16, 12, 0, 0);
  journal = createSessionJournal(join(root, "journal.db"), {
    now: () => clock,
  });
});

afterEach(async () => {
  journal.close();
  await rm(root, { recursive: true, force: true });
});

describe("append and read", () => {
  test("keeps a session's batches in order", () => {
    journal.append(SESSION_A, [a, b]);
    journal.append(SESSION_A, [c, d]);
    expect(journal.readUncovered(SESSION_A).messages).toEqual([a, b, c, d]);
  });

  test("sessions are independent", () => {
    journal.append(SESSION_A, [a, b]);
    journal.append(SESSION_B, [c]);
    journal.append(SESSION_A, [d]);
    expect(journal.readUncovered(SESSION_A).messages).toEqual([a, b, d]);
    expect(journal.readUncovered(SESSION_B).messages).toEqual([c]);
  });

  test("an unknown session reads as empty with no carried text", () => {
    const read = journal.readUncovered("never-written");
    expect(read.messages).toEqual([]);
    expect(read.carried ?? null).toBeNull();
  });
});

describe("idempotent overlap", () => {
  test("the identical batch appended twice adds nothing the second time", () => {
    expect(journal.append(SESSION_A, [a, b, c])).toBe(3);
    expect(journal.append(SESSION_A, [a, b, c])).toBe(0);
    expect(journal.readUncovered(SESSION_A).messages).toEqual([a, b, c]);
  });

  test("a batch overlapping the journal's tail adds only the rest", () => {
    journal.append(SESSION_A, [a, b, c, d]);
    expect(journal.append(SESSION_A, [c, d, e])).toBe(1);
    expect(journal.readUncovered(SESSION_A).messages).toEqual([a, b, c, d, e]);
  });

  test("a batch with no overlap is added whole", () => {
    journal.append(SESSION_A, [a, b]);
    expect(journal.append(SESSION_A, [c, d])).toBe(2);
    expect(journal.readUncovered(SESSION_A).messages).toEqual([a, b, c, d]);
  });

  test("an empty batch adds nothing and does not throw", () => {
    journal.append(SESSION_A, [a]);
    expect(journal.append(SESSION_A, [])).toBe(0);
    expect(journal.append(SESSION_B, [])).toBe(0);
    expect(journal.readUncovered(SESSION_A).messages).toEqual([a]);
    expect(journal.readUncovered(SESSION_B).messages).toEqual([]);
  });

  test("overlap is judged per session", () => {
    journal.append(SESSION_A, [a, b]);
    expect(journal.append(SESSION_B, [a, b])).toBe(2);
    expect(journal.readUncovered(SESSION_B).messages).toEqual([a, b]);
  });

  test("equality is by JSON content, not object identity", () => {
    journal.append(SESSION_A, [user("same"), assistant("reply")]);
    expect(journal.append(SESSION_A, [assistant("reply"), user("next")])).toBe(
      1,
    );
    expect(journal.readUncovered(SESSION_A).messages).toEqual([
      user("same"),
      assistant("reply"),
      user("next"),
    ]);
  });

  test("a repeated user message with a different reply is not swallowed", () => {
    const u1 = user("again?");
    const a1 = assistant("first answer");
    const a2 = assistant("second answer");
    journal.append(SESSION_A, [u1, a1]);
    expect(journal.append(SESSION_A, [u1, a2])).toBe(2);
    expect(journal.readUncovered(SESSION_A).messages).toEqual([u1, a1, u1, a2]);
  });
});

describe("settling a summary", () => {
  test("a fresh session has no carried text", () => {
    journal.append(SESSION_A, [a, b]);
    expect(journal.readUncovered(SESSION_A).carried ?? null).toBeNull();
  });

  test("covers everything up to the cursor and carries the text", () => {
    journal.append(SESSION_A, [a, b]);
    const read = journal.readUncovered(SESSION_A);
    journal.settle(SESSION_A, read.cursor, "summary one");
    const next = journal.readUncovered(SESSION_A);
    expect(next.messages).toEqual([]);
    expect(next.carried).toBe("summary one");
  });

  test("messages appended after the cursor was taken are still returned", () => {
    journal.append(SESSION_A, [a, b]);
    const read = journal.readUncovered(SESSION_A);
    expect(read.messages).toEqual([a, b]);
    journal.append(SESSION_A, [c, d]);
    journal.settle(SESSION_A, read.cursor, "summary of a and b");
    const next = journal.readUncovered(SESSION_A);
    expect(next.messages).toEqual([c, d]);
    expect(next.carried).toBe("summary of a and b");
  });

  test("a second settle replaces the carried text", () => {
    journal.append(SESSION_A, [a, b]);
    journal.settle(SESSION_A, journal.readUncovered(SESSION_A).cursor, "one");
    journal.append(SESSION_A, [c, d]);
    const read = journal.readUncovered(SESSION_A);
    expect(read.messages).toEqual([c, d]);
    expect(read.carried).toBe("one");
    journal.settle(SESSION_A, read.cursor, "two");
    const next = journal.readUncovered(SESSION_A);
    expect(next.messages).toEqual([]);
    expect(next.carried).toBe("two");
  });

  test("settling twice with the same cursor is harmless", () => {
    journal.append(SESSION_A, [a, b]);
    const read = journal.readUncovered(SESSION_A);
    journal.append(SESSION_A, [c]);
    journal.settle(SESSION_A, read.cursor, "summary");
    journal.settle(SESSION_A, read.cursor, "summary");
    const next = journal.readUncovered(SESSION_A);
    expect(next.messages).toEqual([c]);
    expect(next.carried).toBe("summary");
  });

  test("settling one session leaves another uncovered", () => {
    journal.append(SESSION_A, [a]);
    journal.append(SESSION_B, [b]);
    journal.settle(SESSION_A, journal.readUncovered(SESSION_A).cursor, "s");
    expect(journal.readUncovered(SESSION_B).messages).toEqual([b]);
    expect(journal.readUncovered(SESSION_B).carried ?? null).toBeNull();
  });

  test("re-sent covered messages are not journalled again as new", () => {
    journal.append(SESSION_A, [a, b, c, d]);
    journal.settle(SESSION_A, journal.readUncovered(SESSION_A).cursor, "s");
    expect(journal.append(SESSION_A, [c, d, e])).toBe(1);
    expect(journal.append(SESSION_A, [a, b, c, d, e])).toBe(0);
    expect(journal.readUncovered(SESSION_A).messages).toEqual([e]);
  });

  test("an older summary settled after a newer one does not replace it", () => {
    journal.append(SESSION_A, [a, b]);
    const older = journal.readUncovered(SESSION_A);
    journal.append(SESSION_A, [c, d]);
    const newer = journal.readUncovered(SESSION_A);
    expect(newer.messages).toEqual([a, b, c, d]);
    journal.settle(SESSION_A, newer.cursor, "summary of a to d");
    journal.settle(SESSION_A, older.cursor, "summary of a and b");
    const next = journal.readUncovered(SESSION_A);
    expect(next.messages).toEqual([]);
    expect(next.carried).toBe("summary of a to d");
  });
});

describe("drop", () => {
  test("removes a session's messages and carried text only", () => {
    journal.append(SESSION_A, [a, b]);
    journal.settle(SESSION_A, journal.readUncovered(SESSION_A).cursor, "s");
    journal.append(SESSION_A, [c]);
    journal.append(SESSION_B, [d]);
    journal.drop(SESSION_A);
    const dropped = journal.readUncovered(SESSION_A);
    expect(dropped.messages).toEqual([]);
    expect(dropped.carried ?? null).toBeNull();
    expect(journal.readUncovered(SESSION_B).messages).toEqual([d]);
  });

  test("after a drop the session starts afresh", () => {
    journal.append(SESSION_A, [a, b]);
    journal.drop(SESSION_A);
    expect(journal.append(SESSION_A, [a, b])).toBe(2);
    expect(journal.readUncovered(SESSION_A).messages).toEqual([a, b]);
  });
});

describe("prune", () => {
  test("removes sessions idle longer than the age and keeps fresher ones", () => {
    journal.append(SESSION_A, [a]);
    journal.settle(SESSION_A, journal.readUncovered(SESSION_A).cursor, "old");
    clock += 30 * MINUTE_MS;
    journal.append(SESSION_B, [b]);
    clock += 30 * MINUTE_MS;

    journal.prune(45 * MINUTE_MS);

    const pruned = journal.readUncovered(SESSION_A);
    expect(pruned.messages).toEqual([]);
    expect(pruned.carried ?? null).toBeNull();
    expect(journal.readUncovered(SESSION_B).messages).toEqual([b]);
  });

  test("a later write keeps a session fresh", () => {
    journal.append(SESSION_A, [a]);
    clock += 50 * MINUTE_MS;
    journal.append(SESSION_A, [b]);
    clock += 10 * MINUTE_MS;

    journal.prune(45 * MINUTE_MS);

    expect(journal.readUncovered(SESSION_A).messages).toEqual([a, b]);
  });
});

describe("defaultSessionJournalPath", () => {
  let savedMimirHome: string | undefined;

  beforeEach(() => {
    savedMimirHome = process.env.MIMIR_HOME;
    process.env.MIMIR_HOME = root;
  });

  afterEach(() => {
    if (savedMimirHome === undefined) delete process.env.MIMIR_HOME;
    else process.env.MIMIR_HOME = savedMimirHome;
  });

  test("is a database file directly under Mimir's home", () => {
    const path = defaultSessionJournalPath();
    expect(dirname(path)).toBe(root);
    expect(path.endsWith(".db")).toBe(true);
  });
});
