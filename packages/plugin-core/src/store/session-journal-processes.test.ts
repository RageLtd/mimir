import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionJournal } from "./session-journal";

const SESSION = "raced-session";
const CHILDREN = 8;
const MESSAGES_PER_STEP = 5;
const CONVERSATION_LENGTH = 50;
const ROUNDS = 4;

const STORE_MODULE = join(import.meta.dir, "session-journal.ts");

const conversation = Array.from({ length: CONVERSATION_LENGTH }, (_, i) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: [{ type: "text", text: `message ${i}` }],
}));

// Child k appends the first k×5 messages, so every batch is a prefix of the
// longest and the batches nest.
const CHILD_SCRIPT = `
import { createSessionJournal } from ${JSON.stringify(STORE_MODULE)};
const [dbPath, session, countText, conversationJson] = process.argv.slice(2);
const conversation = JSON.parse(conversationJson);
const journal = createSessionJournal(dbPath);
journal.append(session, conversation.slice(0, Number(countText)));
journal.close();
`;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mimir-session-journal-race-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("concurrent processes appending nested batches journal each message once, in order", async () => {
  const childPath = join(root, "append-child.ts");
  await Bun.write(childPath, CHILD_SCRIPT);
  const longest = conversation.slice(0, CHILDREN * MESSAGES_PER_STEP);

  for (let round = 0; round < ROUNDS; round++) {
    const dbPath = join(root, `journal-${round}.db`);
    const children = Array.from({ length: CHILDREN }, (_, i) =>
      Bun.spawn(
        [
          process.execPath,
          childPath,
          dbPath,
          SESSION,
          String((i + 1) * MESSAGES_PER_STEP),
          JSON.stringify(conversation),
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );
    const outcomes = await Promise.all(
      children.map(async (child) => ({
        code: await child.exited,
        stderr: await new Response(child.stderr).text(),
      })),
    );
    expect(outcomes.map((o) => (o.code === 0 ? 0 : o.stderr))).toEqual(
      Array.from({ length: CHILDREN }, () => 0),
    );

    const journal = createSessionJournal(dbPath);
    const read = journal.readUncovered(SESSION);
    journal.close();
    expect(read.messages).toEqual(longest);
  }
}, 60_000);
