/**
 * `precompact` builds its summary from the session journal, not from the
 * payload's `window`: the summariser is given the session's uncovered
 * journal (after this run's own `messages` are appended), led by the
 * previous summary when one was carried. A stored summary settles the
 * journal; a run that stores none leaves it as it was. Facts extraction
 * still reads the payload's `messages` alone.
 *
 * Driven end to end in host-completions mode: phase one answers with
 * `requests`, whose `summary.prompt` is what the summariser would be given;
 * phase two hands back `completions` and stores them. Stores are scratch
 * databases named through the environment.
 */

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
const SESSION = "session-precompact-journal";
// Nothing listens here: the run stores without embeddings, deterministically.
const CLOSED_EMBEDDER_PORT = "1";
const CARRIED_LABEL = "Summary of this session before the last compaction:";

const text = (role: "user" | "assistant", body: string) => ({
  role,
  content: [{ type: "text", text: body }],
});

/** Four messages, two user turns, each line carrying `marker`. */
const turns = (marker: string) => [
  text(
    "user",
    `${marker}: we decided the sync relay stays blind and the server never parses memory content.`,
  ),
  text(
    "assistant",
    `${marker}: understood, so extraction and embeddings run client-side and the server only distributes wrapped keys.`,
  ),
  text(
    "user",
    `${marker}: and the cc-plugin uses the session's own model when no extraction endpoint is configured.`,
  ),
  text(
    "assistant",
    `${marker}: noted, a configured endpoint wins when present and the session model covers the rest of the time.`,
  ),
];

const EARLIER_MARK = "alpha-earlier";
const TAIL_MARK = "bravo-tail";
const WINDOW_MARK = "charlie-window";
const LATER_MARK = "delta-later";
const LATEST_MARK = "echo-latest";

const EARLIER = turns(EARLIER_MARK);
const TAIL = turns(TAIL_MARK);
const WINDOW_ONLY = turns(WINDOW_MARK);
const LATER = turns(LATER_MARK);
const LATEST = turns(LATEST_MARK);
const SHORT = [text("user", "hi")];

const FIRST_SUMMARY =
  "The session settled that the sync relay stays blind and that extraction runs client-side, with the session model as the fallback.";
const SECOND_SUMMARY =
  "Building on the earlier settlement, the session confirmed the endpoint precedence and closed out the remaining questions.";
const FACT = "the sync relay stays blind";
const FACTS_COMPLETION = { facts: { text: JSON.stringify([FACT]) } };
const completionsWith = (summary: string) => ({
  summary: { text: summary },
  ...FACTS_COMPLETION,
});

let dir = "";
let journalPath = "";
let replicaPath = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mimir-precompact-journal-"));
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

type Answer = {
  readonly advance: boolean;
  readonly requests?: Record<string, { readonly prompt: string }>;
};

const run = async (
  command: "persist" | "precompact",
  payload: Record<string, unknown>,
  overrides: Record<string, string> = {},
) => {
  const proc = Bun.spawn([process.execPath, CLI, command], {
    cwd: PACKAGE_DIR,
    env: runEnv(overrides),
    stdin: new Blob([
      JSON.stringify({
        session_id: SESSION,
        cwd: dir,
        host_completions: true,
        ...payload,
      }),
    ]),
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
  // Serialisation boundary: the run printed this JSON.
  const answer: Answer = JSON.parse(stdout);
  return answer;
};

const escapeRegExp = (literal: string) =>
  literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const summaryPrompt = (answer: Answer) => answer.requests?.summary?.prompt;

const uncovered = () => {
  const journal = createSessionJournal(journalPath);
  const read = journal.readUncovered(SESSION);
  journal.close();
  return read;
};

const stored = (type: string) => {
  if (!existsSync(replicaPath)) return [];
  const replica = createOrgReplica(replicaPath);
  const contents = replica
    .listMemories(1000)
    .filter((row) => row.type === type)
    .map((row) => row.content)
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

/** Journal EARLIER through persist, then compact with TAIL and a window. */
const compactOnce = async (summary = FIRST_SUMMARY) => {
  await run("persist", { messages: EARLIER });
  const payload = { messages: TAIL, window: [...WINDOW_ONLY, ...TAIL] };
  const first = await run("precompact", payload);
  await run("precompact", {
    ...payload,
    completions: completionsWith(summary),
  });
  return first;
};

describe("the summary is built from the uncovered journal", () => {
  test(
    "text journalled by an earlier persist reaches the summariser; text only in the window does not",
    async () => {
      await run("persist", { messages: EARLIER });
      const answer = await run("precompact", {
        messages: TAIL,
        window: [...WINDOW_ONLY, ...TAIL],
      });
      const prompt = summaryPrompt(answer);
      expect(prompt).toBeDefined();
      expect(prompt).toContain(EARLIER_MARK);
      expect(prompt).toContain(TAIL_MARK);
      expect(prompt).not.toContain(WINDOW_MARK);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "a stored summary settles the journal: nothing uncovered, the summary carried",
    async () => {
      await compactOnce();
      expect(stored("summary")).toEqual([FIRST_SUMMARY]);
      const read = uncovered();
      expect(read.messages).toEqual([]);
      expect(read.carried).toBe(FIRST_SUMMARY);
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "a later run gives the carried summary first, labelled, then only what was journalled since",
    async () => {
      await compactOnce();
      await run("persist", { messages: LATER });
      const answer = await run("precompact", { messages: LATEST });
      const prompt = summaryPrompt(answer) ?? "";

      const [firstLine] = prompt.split("\n");
      expect(firstLine).toContain(CARRIED_LABEL);
      expect(prompt.split(CARRIED_LABEL)).toHaveLength(2);
      expect(prompt).toMatch(
        new RegExp(
          `${escapeRegExp(CARRIED_LABEL)}\\s*${escapeRegExp(FIRST_SUMMARY)}`,
        ),
      );
      expect(prompt).toContain(LATER_MARK);
      expect(prompt).toContain(LATEST_MARK);
      expect(prompt.indexOf(FIRST_SUMMARY)).toBeLessThan(
        prompt.indexOf(LATER_MARK),
      );
      expect(prompt).not.toContain(EARLIER_MARK);
      expect(prompt).not.toContain(TAIL_MARK);

      await run("precompact", {
        messages: LATEST,
        completions: completionsWith(SECOND_SUMMARY),
      });
      const read = uncovered();
      expect(read.messages).toEqual([]);
      expect(read.carried).toBe(SECOND_SUMMARY);
    },
    RUN_TIMEOUT_MS,
  );
});

describe("an empty tail still summarises the journal", () => {
  test(
    "a run with messages [] asks for a summary of the uncovered journal, and its second phase stores it and settles the journal",
    async () => {
      await run("persist", { messages: EARLIER });
      await run("persist", { messages: TAIL });

      const answer = await run("precompact", { messages: [] });
      const prompt = summaryPrompt(answer);
      expect(prompt).toBeDefined();
      expect(prompt).toContain(EARLIER_MARK);
      expect(prompt).toContain(TAIL_MARK);

      await run("precompact", {
        messages: [],
        completions: completionsWith(FIRST_SUMMARY),
      });
      expect(stored("summary")).toEqual([FIRST_SUMMARY]);
      const read = uncovered();
      expect(read.messages).toEqual([]);
      expect(read.carried).toBe(FIRST_SUMMARY);
    },
    RUN_TIMEOUT_MS,
  );
});

describe("nothing uncovered asks for no summary", () => {
  test(
    "a run whose messages are all covered requests and stores no summary; facts are unchanged",
    async () => {
      const baseline = await run(
        "precompact",
        { messages: TAIL },
        { MIMIR_SESSION_JOURNAL_DB: join(dir, "baseline.db") },
      );
      await compactOnce();

      const answer = await run("precompact", { messages: TAIL });
      expect(answer.requests?.summary).toBeUndefined();
      expect(answer.requests?.facts).toEqual(baseline.requests?.facts);

      await run("precompact", {
        messages: TAIL,
        completions: completionsWith(SECOND_SUMMARY),
      });
      expect(stored("summary")).toEqual([FIRST_SUMMARY]);
      expect(stored("fact")).toContain(FACT);
      expect(uncovered().carried).toBe(FIRST_SUMMARY);
    },
    RUN_TIMEOUT_MS,
  );
});

describe("no stored summary, no settle", () => {
  test(
    "a first phase that only answers with requests leaves the journal uncovered",
    async () => {
      await run("persist", { messages: EARLIER });
      const answer = await run("precompact", { messages: TAIL });
      expect(summaryPrompt(answer)).toBeDefined();
      const read = uncovered();
      expect(read.messages).toEqual([...EARLIER, ...TAIL]);
      expect(read.carried).toBeNull();
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "a journal under the summary gate stores no summary and is not settled",
    async () => {
      await run("precompact", {
        messages: SHORT,
        completions: completionsWith(FIRST_SUMMARY),
      });
      expect(stored("summary")).toEqual([]);
      const read = uncovered();
      expect(read.messages).toEqual(SHORT);
      expect(read.carried).toBeNull();
    },
    RUN_TIMEOUT_MS,
  );

  test(
    "a blank summary completion stores no summary and is not settled",
    async () => {
      await run("persist", { messages: EARLIER });
      await run("precompact", {
        messages: TAIL,
        completions: completionsWith("   "),
      });
      expect(stored("summary")).toEqual([]);
      const read = uncovered();
      expect(read.messages).toEqual([...EARLIER, ...TAIL]);
      expect(read.carried).toBeNull();
    },
    RUN_TIMEOUT_MS,
  );
});

describe("a journal that cannot be opened", () => {
  test(
    "no summary is requested or stored, even with a window; facts behave as with a working journal",
    async () => {
      const payload = { messages: TAIL, window: [...WINDOW_ONLY, ...TAIL] };
      const working = await run("precompact", payload);
      await run("precompact", {
        ...payload,
        completions: completionsWith(FIRST_SUMMARY),
      });
      const workingFacts = stored("fact");
      expect(workingFacts).toContain(FACT);

      await rm(replicaPath, { force: true });
      const broken = { MIMIR_SESSION_JOURNAL_DB: await unopenableJournal() };
      const answer = await run("precompact", payload, broken);
      expect(answer.requests?.summary).toBeUndefined();
      expect(answer.requests?.facts).toEqual(working.requests?.facts);

      await run(
        "precompact",
        { ...payload, completions: completionsWith(FIRST_SUMMARY) },
        broken,
      );
      expect(stored("summary")).toEqual([]);
      expect(stored("fact")).toEqual(workingFacts);
    },
    RUN_TIMEOUT_MS,
  );
});
