/**
 * `persist` and `precompact` write the session journal: each run appends the
 * `messages` it was handed (as the hook sent them) under the payload's
 * `session_id`, whatever it then decides, so a summary can still be written
 * after the host discards the conversation. Journal trouble never changes
 * what a run answers or stores.
 *
 * Both runs read their payload from stdin and their stores from the
 * environment, so they are driven end to end: `bun src/cli.ts <command>`
 * with `MIMIR_SESSION_JOURNAL_DB` and `MIMIR_ORG_REPLICA_DB` pointed at a
 * scratch directory.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createOrgReplica } from "@mimir/plugin-core/store/org-replica";
import { createSessionJournal } from "@mimir/plugin-core/store/session-journal";

const PACKAGE_DIR = dirname(import.meta.dir);
const CLI = join(import.meta.dir, "cli.ts");
const RUN_TIMEOUT_MS = 60_000;
const SESSION = "session-journal-a";
// Nothing listens here: the run stores without embeddings, deterministically.
const CLOSED_EMBEDDER_PORT = "1";

const text = (role: "user" | "assistant", body: string) => ({
  role,
  content: [{ type: "text", text: body }],
});

// Two user turns, well past the extraction and summary gates.
const LONG = [
  text(
    "user",
    "We decided the sync relay stays blind: the server never parses memory content, only ciphertext.",
  ),
  text(
    "assistant",
    "Understood. Extraction and embeddings therefore run client-side, and the server only distributes wrapped keys.",
  ),
  text(
    "user",
    "Right, and the cc-plugin should use Haiku through the session's own client when no endpoint is configured.",
  ),
  text(
    "assistant",
    "Noted: a configured extraction endpoint and model win when present; otherwise Haiku via the session client.",
  ),
];

// One user turn: the extraction gate skips.
const SHORT = [text("user", "hi")];

const WINDOW_ONLY = [
  text("user", "An earlier turn that only the window carries."),
  text("assistant", "And its reply, also outside the tail."),
];

const FACT = "the sync relay stays blind";
const FACTS_COMPLETION = { facts: { text: JSON.stringify([FACT]) } };

let dir = "";
let journalPath = "";
let replicaPath = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mimir-distill-journal-"));
  journalPath = join(dir, "session-journal.db");
  replicaPath = join(dir, "org-replica.db");
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

/** The environment a hook run sees: no inherited Mimir settings. */
const runEnv = (overrides: Record<string, string>) => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("MIMIR_")) env[key] = value;
  }
  return {
    ...env,
    MIMIR_ACTIVE: "1",
    MIMIR_HOME: join(dir, "home"),
    MIMIR_ORG_REPLICA_DB: replicaPath,
    MIMIR_SESSION_JOURNAL_DB: journalPath,
    MIMIR_EMBEDDER_PORT: CLOSED_EMBEDDER_PORT,
    ...overrides,
  };
};

const run = async (
  command: "persist" | "precompact",
  payload: unknown,
  overrides: Record<string, string> = {},
) => {
  const proc = Bun.spawn([process.execPath, CLI, command], {
    cwd: PACKAGE_DIR,
    env: runEnv(overrides),
    stdin: new Blob([JSON.stringify(payload)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`mimir-cc ${command} exited ${code}: ${stderr}`);
  }
  return stdout;
};

const journalled = (sessionId: string) => {
  const journal = createSessionJournal(journalPath);
  const { messages } = journal.readUncovered(sessionId);
  journal.close();
  return messages;
};

/** Rows journalled for any session; 0 when no journal file was made. */
const journalRowCount = () => {
  if (!existsSync(journalPath)) return 0;
  const db = new Database(journalPath, { readonly: true });
  const tables = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'journal_message'",
    )
    .all();
  const count =
    tables.length === 0
      ? 0
      : (db
          .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM journal_message")
          .get()?.n ?? 0);
  db.close();
  return count;
};

const storedContents = () => {
  if (!existsSync(replicaPath)) return [];
  const replica = createOrgReplica(replicaPath);
  const contents = replica
    .listMemories(1000)
    .map((row) => `${row.type}:${row.content}`)
    .sort();
  replica.close();
  return contents;
};

/** A journal path that cannot be opened: its parent is a regular file. */
const unopenableJournal = async () => {
  const blocker = join(dir, "not-a-directory");
  await writeFile(blocker, "a regular file");
  return join(blocker, "session-journal.db");
};

const persistPayload = (extra: Record<string, unknown> = {}) => ({
  session_id: SESSION,
  cwd: dir,
  host_completions: true,
  messages: LONG,
  ...extra,
});

describe("persist journals the delta it was handed", () => {
  test(
    "a payload whose plan stores facts journals its messages as sent",
    async () => {
      await run("persist", persistPayload({ completions: FACTS_COMPLETION }));
      expect(journalled(SESSION)).toEqual(LONG);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "a payload whose plan settles without storing journals its messages",
    async () => {
      const out = await run("persist", persistPayload({ messages: SHORT }));
      expect(JSON.parse(out)).toEqual({ advance: false });
      expect(journalled(SESSION)).toEqual(SHORT);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "a request phase and its second phase journal each message once",
    async () => {
      const first = await run("persist", persistPayload());
      expect(JSON.parse(first).requests).toBeDefined();
      expect(journalled(SESSION)).toEqual(LONG);

      await run("persist", persistPayload({ completions: FACTS_COMPLETION }));
      expect(journalled(SESSION)).toEqual(LONG);
    },
    RUN_TIMEOUT_MS,
  );
});

describe("precompact journals the tail it was handed", () => {
  test(
    "with a window, the tail is journalled and the window is not",
    async () => {
      await run("precompact", {
        session_id: SESSION,
        cwd: dir,
        host_completions: true,
        messages: LONG,
        window: [...WINDOW_ONLY, ...LONG],
      });
      expect(journalled(SESSION)).toEqual(LONG);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "without a window, the tail is journalled",
    async () => {
      await run("precompact", {
        session_id: SESSION,
        cwd: dir,
        host_completions: true,
        messages: LONG,
      });
      expect(journalled(SESSION)).toEqual(LONG);
    },
    RUN_TIMEOUT_MS,
  );
});

// precompact is not here: its summary is built from the journal, so without
// one it stores no summary (precompact-journal.spec.ts holds that case).
describe("a journal that cannot be opened changes nothing persist does", () => {
  const cases = [
    {
      command: "persist" as const,
      payload: persistPayload({ completions: FACTS_COMPLETION }),
    },
    {
      command: "persist" as const,
      payload: persistPayload({ messages: SHORT }),
    },
  ];

  for (const [i, { command, payload }] of cases.entries()) {
    test(
      `${command} case ${i}: same answer, same stored rows`,
      async () => {
        // `dir` is fresh per test; rebuild the payload's cwd from it.
        const sent = { ...payload, cwd: dir };
        const working = await run(command, sent);
        const workingRows = storedContents();
        expect(journalled(SESSION).length).toBeGreaterThan(0);

        await rm(replicaPath, { force: true });
        const broken = await run(command, sent, {
          MIMIR_SESSION_JOURNAL_DB: await unopenableJournal(),
        });

        expect(broken).toBe(working);
        expect(storedContents()).toEqual(workingRows);
      },
      RUN_TIMEOUT_MS,
    );
  }
});

describe("nothing is journalled when the run does nothing", () => {
  for (const command of ["persist", "precompact"] as const) {
    test(
      `${command}: MIMIR_ACTIVE not "1"`,
      async () => {
        await run(command, persistPayload(), { MIMIR_ACTIVE: "0" });
        expect(journalRowCount()).toBe(0);
      },
      RUN_TIMEOUT_MS,
    );

    test(
      `${command}: a payload with no session_id`,
      async () => {
        const { session_id: _id, ...rest } = persistPayload();
        await run(command, rest);
        expect(journalRowCount()).toBe(0);
      },
      RUN_TIMEOUT_MS,
    );

    test(
      `${command}: a stale payload (a session_id and no messages)`,
      async () => {
        await run(command, { session_id: SESSION, cwd: dir });
        expect(journalRowCount()).toBe(0);
      },
      RUN_TIMEOUT_MS,
    );
  }
});
