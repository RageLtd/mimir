/**
 * `session-end` summarises from the session journal. The payload is
 * `{ session_id, cwd, reason, messages }`, `messages` being the tail not yet
 * distilled: the runner appends it to the session's journal and hands the
 * detached worker a hand-off that names the session and carries no
 * conversation text. The worker builds the summary from the journal as
 * `precompact` does — the carried summary first, labelled, then the
 * uncovered messages — and a stored summary settles the journal. A `window`
 * in the payload is ignored. The journal outlives the run whatever the
 * `reason`; only the session-start worker's age prune removes it.
 *
 * The runner is driven in-process with injected deps; the worker runs as
 * `mimir-cc session-end --worker <file>` on the hand-off the runner made,
 * against a stand-in extraction endpoint that records what it is asked.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtractionConfig } from "@mimir/plugin-core/brain/extract";
import { createOrgReplica } from "@mimir/plugin-core/store/org-replica";
import { createSessionJournal } from "@mimir/plugin-core/store/session-journal";
import type { ApiMessage } from "./conversation";
import { runSessionEndHook, writeHandOff } from "./session-end-hook";

const JOURNAL_ENV = "MIMIR_SESSION_JOURNAL_DB";
const ENDING = "session-ending";
const OTHER = "session-other";
const PROJECT = "project:session-end-journal";
const TOKEN = "token-1";
const CWD = "/work/repo";
const PACKAGE_DIR = dirname(import.meta.dir);
const CLI = join(import.meta.dir, "cli.ts");
const RUN_TIMEOUT_MS = 60_000;
const CLOSED_EMBEDDER_PORT = "1";
const CARRIED_LABEL = "Summary of this session before the last compaction:";

const BYOK: ExtractionConfig = {
  baseUrl: "http://localhost:11434/v1",
  model: "llama3",
};

const text = (role: "user" | "assistant", body: string) =>
  ({
    role,
    content: [{ type: "text", text: body }],
  }) satisfies ApiMessage;

/** Four messages, each carrying `marker`, well past the summary floor. */
const turns = (marker: string) =>
  Array.from({ length: 4 }, (_, i) =>
    text(
      i % 2 === 0 ? "user" : "assistant",
      `${marker} turn ${i}: we decided the sync relay stays blind and the server only distributes wrapped keys, never parsing memory content.`,
    ),
  );

const EARLIER_MARK = "alpha-earlier";
const TAIL_MARK = "bravo-tail";
const WINDOW_MARK = "charlie-window";
const LATER_MARK = "delta-later";
const EARLIER = turns(EARLIER_MARK);
const TAIL = turns(TAIL_MARK);
const WINDOW_ONLY = turns(WINDOW_MARK);
const LATER = turns(LATER_MARK);
const OTHER_MESSAGES = [text("user", "another session's turn")];
const CONVERSATION_MARKS = [EARLIER_MARK, TAIL_MARK, WINDOW_MARK, LATER_MARK];

const FIRST_SUMMARY =
  "The ending session settled that the sync relay stays blind and that only wrapped keys are distributed.";
const SECOND_SUMMARY =
  "Carrying the earlier settlement forward, the session closed out its remaining questions.";

let dir = "";
let journalPath = "";
let replicaPath = "";
let savedEnv: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mimir-session-end-journal-"));
  journalPath = join(dir, "session-journal.db");
  replicaPath = join(dir, "org-replica.db");
  savedEnv = process.env[JOURNAL_ENV];
  process.env[JOURNAL_ENV] = journalPath;
});

afterEach(async () => {
  if (savedEnv === undefined) delete process.env[JOURNAL_ENV];
  else process.env[JOURNAL_ENV] = savedEnv;
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = "";
});

const withJournal = <T>(
  use: (journal: ReturnType<typeof createSessionJournal>) => T,
) => {
  const journal = createSessionJournal(journalPath);
  const result = use(journal);
  journal.close();
  return result;
};

const seed = (messages: readonly ApiMessage[] = EARLIER) =>
  withJournal((journal) => {
    journal.append(ENDING, messages);
    journal.append(OTHER, OTHER_MESSAGES);
  });

const uncovered = (sessionId: string) =>
  withJournal((journal) => journal.readUncovered(sessionId));

type HandOff = Parameters<typeof writeHandOff>[0];

/** The runner's deps, recording marks, clears and hand-offs. */
const runner = (extraction: ExtractionConfig | null = BYOK) => {
  const spawned: HandOff[] = [];
  const marks: string[] = [];
  const clears: string[] = [];
  return {
    spawned,
    marks,
    clears,
    deps: {
      extraction,
      cachedProjectId: async () => PROJECT,
      markPending: async (projectId: string) => {
        marks.push(projectId);
        return TOKEN;
      },
      clearPending: async (projectId: string) => {
        clears.push(projectId);
      },
      spawnWorker: async (handOff: HandOff) => {
        spawned.push(handOff);
      },
      sweepFileContextState: async () => ({ removed: 0, failures: [] }),
      log: { info: () => {}, warn: () => {}, error: () => {} },
    },
  };
};

const ending = (
  messages: readonly ApiMessage[],
  extra: Record<string, unknown> = {},
) => ({
  session_id: ENDING,
  cwd: CWD,
  reason: "prompt_input_exit",
  messages,
  ...extra,
});

describe("the runner journals the tail and hands off no conversation", () => {
  test("the tail is appended to the ending session's journal", async () => {
    seed();
    await runSessionEndHook(ending(TAIL), runner().deps);
    expect(uncovered(ENDING).messages).toEqual([...EARLIER, ...TAIL]);
  });

  test("the hand-off names the session and carries no message from the journal or the payload", async () => {
    seed();
    const { spawned, deps } = runner();
    await runSessionEndHook(ending(TAIL, { window: WINDOW_ONLY }), deps);

    expect(spawned).toHaveLength(1);
    const handOff = JSON.stringify(spawned[0]);
    expect(handOff).toContain(ENDING);
    for (const mark of CONVERSATION_MARKS) {
      expect(handOff).not.toContain(mark);
    }
  });

  test("a window in the payload is ignored: a window alone hands nothing off and journals nothing", async () => {
    const { spawned, deps } = runner();
    await runSessionEndHook(ending([], { window: WINDOW_ONLY }), deps);
    expect(spawned).toEqual([]);
    expect(uncovered(ENDING).messages).toEqual([]);
  });

  test("nothing uncovered after the append: no hand-off, and nothing left pending", async () => {
    seed(TAIL);
    withJournal((journal) => {
      const { cursor } = journal.readUncovered(ENDING);
      journal.settle(ENDING, cursor, FIRST_SUMMARY);
    });
    for (const messages of [TAIL, []]) {
      const { spawned, marks, clears, deps } = runner();
      await runSessionEndHook(ending(messages), deps);
      expect(spawned).toEqual([]);
      expect(clears).toEqual(marks);
    }
  });
});

const PATHS = [
  { what: "summarise", extraction: BYOK, messages: TAIL },
  { what: "unconfigured", extraction: null, messages: TAIL },
  { what: "nothing new", extraction: BYOK, messages: [] },
];

const REASONS = ["prompt_input_exit", "clear", "logout", "other"];

describe("session-end keeps the session journal", () => {
  for (const { what, extraction, messages } of PATHS) {
    test(`${what}: the ending session's journal holds what was there plus the tail; another's is unchanged`, async () => {
      seed();
      for (const reason of REASONS) {
        const code = await runSessionEndHook(
          { session_id: ENDING, cwd: CWD, reason, messages },
          runner(extraction).deps,
        );
        expect(code).toBe(0);
        expect(uncovered(ENDING).messages).toEqual([...EARLIER, ...messages]);
        expect(uncovered(OTHER).messages).toEqual(OTHER_MESSAGES);
      }
    });
  }
});

/** A stand-in extraction endpoint answering each request with `reply()`. */
const fakeEndpoint = (reply: () => string) => {
  const prompts: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      // Serialisation boundary: the worker's chat-completions request.
      const body = (await req.json()) as {
        messages: { role: string; content: string }[];
      };
      prompts.push(body.messages.find((m) => m.role === "user")?.content ?? "");
      return Response.json({
        choices: [{ message: { role: "assistant", content: reply() } }],
      });
    },
  });
  return { prompts, server };
};

const workerEnv = (baseUrl: string) => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("MIMIR_")) env[key] = value;
  }
  return {
    ...env,
    MIMIR_HOME: join(dir, "home"),
    MIMIR_ORG_REPLICA_DB: replicaPath,
    MIMIR_SESSION_JOURNAL_DB: journalPath,
    MIMIR_EMBEDDER_PORT: CLOSED_EMBEDDER_PORT,
    MIMIR_EXTRACTION_BASE_URL: baseUrl,
    MIMIR_EXTRACTION_MODEL: "stand-in",
  };
};

/** End the session with `messages`, then run the worker on its hand-off. */
const endAndSummarise = async (
  messages: readonly ApiMessage[],
  baseUrl: string,
) => {
  const { spawned, deps } = runner();
  await runSessionEndHook(ending(messages, { window: WINDOW_ONLY }), deps);
  const [handOff] = spawned;
  if (handOff === undefined) throw new Error("the runner handed nothing off");
  const path = await writeHandOff(handOff);
  const proc = Bun.spawn(
    [process.execPath, CLI, "session-end", "--worker", path],
    {
      cwd: PACKAGE_DIR,
      env: workerEnv(baseUrl),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stderr, code] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`worker exited ${code}: ${stderr}`);
};

const storedSummaries = () => {
  if (!existsSync(replicaPath)) return [];
  const replica = createOrgReplica(replicaPath);
  const contents = replica
    .listMemories(1000)
    .filter((row) => row.type === "summary")
    .map((row) => row.content)
    .sort();
  replica.close();
  return contents;
};

const escapeRegExp = (literal: string) =>
  literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("the worker summarises from the journal", () => {
  test(
    "the summary is built from the uncovered journal and settles it; a later one leads with the carried summary",
    async () => {
      const replies = [FIRST_SUMMARY, SECOND_SUMMARY];
      const { prompts, server } = fakeEndpoint(() => replies.shift() ?? "");
      const baseUrl = `http://127.0.0.1:${server.port}`;
      try {
        seed();
        await endAndSummarise(TAIL, baseUrl);

        expect(prompts).toHaveLength(1);
        const [first = ""] = prompts;
        expect(first).toContain(EARLIER_MARK);
        expect(first).toContain(TAIL_MARK);
        expect(first).not.toContain(WINDOW_MARK);
        expect(first).not.toContain(CARRIED_LABEL);
        expect(storedSummaries()).toEqual([FIRST_SUMMARY]);
        expect(uncovered(ENDING)).toMatchObject({
          messages: [],
          carried: FIRST_SUMMARY,
        });

        await endAndSummarise(LATER, baseUrl);

        expect(prompts).toHaveLength(2);
        const [, second = ""] = prompts;
        const [firstLine] = second.split("\n");
        expect(firstLine).toContain(CARRIED_LABEL);
        expect(second).toMatch(
          new RegExp(
            `${escapeRegExp(CARRIED_LABEL)}\\s*${escapeRegExp(FIRST_SUMMARY)}`,
          ),
        );
        expect(second).toContain(LATER_MARK);
        expect(second).not.toContain(EARLIER_MARK);
        expect(second).not.toContain(TAIL_MARK);
        expect(second).not.toContain(WINDOW_MARK);
        expect(uncovered(ENDING)).toMatchObject({
          messages: [],
          carried: SECOND_SUMMARY,
        });
        expect(uncovered(OTHER).messages).toEqual(OTHER_MESSAGES);
      } finally {
        server.stop(true);
      }
    },
    RUN_TIMEOUT_MS,
  );
});
