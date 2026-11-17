/**
 * retrieveForPrompt: the one retrieve sequence every editor adapter runs for
 * a developer prompt — open the replica, resolve the project, read the
 * session's seen rows, check the summary-pending mark, retrieve, close,
 * record. And promptContextOutput: the pure map from a retrieval to what a
 * UserPromptSubmit hook prints.
 *
 * Every side effect is injected. The replica is an in-memory one, only so
 * it carries the real type; nothing reads from it, since retrieval is faked.
 */

import { describe, expect, test } from "bun:test";
import type { Logger } from "../logger";
import type { activeProjectId } from "../project/active";
import type { readProjectNames } from "../project/cache";
import type {
  clearInjectedIds,
  readInjectedIds,
  recordInjectedIds,
} from "../retrieve-state";
import { createOrgReplica, type OrgReplica } from "../store/org-replica";
import type { isSummaryPending } from "../summary-pending";
import type { createEmbedQuery } from "./embedder";
import type { RetrievedContext, retrieveLocalContext } from "./retrieve";
import { promptContextOutput, retrieveForPrompt } from "./retrieve-prompt";

const PROJECT = "project:a";
const SESSION = "session-1";
const PROMPT = "how does sync work?";
const CWD = "/work/repo";
const BLOCK = "<retrieved_context>one memory</retrieved_context>";
const PROJECT_NAMES = { "project:b": "data-services" };

const recordingLogger = () => {
  const warnings: unknown[][] = [];
  const log: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, context) => {
      warnings.push([message, context]);
    },
    error: () => undefined,
  };
  return { warnings, log };
};

const result = (over: Partial<RetrievedContext> = {}) => ({
  contextBlock: over.contextBlock ?? "",
  memoryCount: over.memoryCount ?? 0,
  summaryCount: over.summaryCount ?? 0,
  injectedIds: over.injectedIds ?? [],
  embedderUnavailable: over.embedderUnavailable ?? false,
  summaryDeferred: over.summaryDeferred ?? false,
});

type RetrieveOptions = Parameters<typeof retrieveLocalContext>[2];

type FakeSetup = {
  readonly openFails?: boolean;
  readonly projectId?: string | null;
  readonly seen?: ReadonlySet<string>;
  readonly readFails?: boolean;
  readonly clearFails?: boolean;
  readonly pending?: boolean;
  readonly pendingFails?: boolean;
  readonly retrieved?: RetrievedContext;
  readonly retrieveFails?: boolean;
  readonly recordFails?: boolean;
};

/** Every dep faked; each call is recorded, in order, in `events`. */
const fakeDeps = (setup: FakeSetup = {}) => {
  const events: string[] = [];
  const pendingCalls: [string, number | undefined][] = [];
  const recorded: [string, readonly string[]][] = [];
  const retrieveCalls: {
    replica: OrgReplica;
    prompt: string;
    options: RetrieveOptions;
  }[] = [];
  const projectCalls: string[] = [];
  const embedQuery = async () => null;
  const real = createOrgReplica(":memory:");
  const replica: OrgReplica = {
    ...real,
    close: () => {
      events.push("close");
      real.close();
    },
  };

  const activeProject: typeof activeProjectId = async (dir) => {
    events.push("project");
    projectCalls.push(dir);
    return setup.projectId === undefined ? PROJECT : setup.projectId;
  };
  const readSeen: typeof readInjectedIds = async (sessionId) => {
    events.push(`read:${sessionId}`);
    if (setup.readFails) throw new Error("state unreadable");
    return new Set(setup.seen ?? []);
  };
  const clearSeen: typeof clearInjectedIds = async (sessionId) => {
    events.push(`clear:${sessionId}`);
    if (setup.clearFails) throw new Error("state unclearable");
  };
  const recordSeen: typeof recordInjectedIds = async (sessionId, ids) => {
    events.push(`record:${sessionId}`);
    recorded.push([sessionId, ids]);
    if (setup.recordFails) throw new Error("state unwritable");
  };
  const summaryPending: typeof isSummaryPending = async (projectId, now) => {
    events.push("pending");
    pendingCalls.push([projectId, now]);
    if (setup.pendingFails) throw new Error("mark unreadable");
    return setup.pending === true;
  };
  const projectNames: typeof readProjectNames = async () => PROJECT_NAMES;
  const retrieve: typeof retrieveLocalContext = async (r, prompt, options) => {
    events.push("retrieve");
    retrieveCalls.push({ replica: r, prompt, options });
    if (setup.retrieveFails) throw new Error("vector index corrupt");
    return setup.retrieved ?? result();
  };
  const embedder: typeof createEmbedQuery = () => embedQuery;

  return {
    events,
    pendingCalls,
    recorded,
    retrieveCalls,
    projectCalls,
    replica,
    embedQuery,
    deps: {
      openReplica: () => {
        events.push("open");
        if (setup.openFails) throw new Error("disk is gone");
        return replica;
      },
      activeProjectId: activeProject,
      readInjectedIds: readSeen,
      clearInjectedIds: clearSeen,
      recordInjectedIds: recordSeen,
      isSummaryPending: summaryPending,
      readProjectNames: projectNames,
      retrieveLocalContext: retrieve,
      createEmbedQuery: embedder,
    },
  };
};

const onlyRetrieveCall = (fake: ReturnType<typeof fakeDeps>) => {
  expect(fake.retrieveCalls).toHaveLength(1);
  const [call] = fake.retrieveCalls;
  if (call === undefined) throw new Error("retrieval was never called");
  return call;
};

const input = (
  log: Logger,
  over: { noSession?: boolean; windowReset?: boolean; sessionStart?: boolean },
) => ({
  sessionId: over.noSession ? undefined : SESSION,
  cwd: CWD,
  prompt: PROMPT,
  windowReset: over.windowReset,
  sessionStart: over.sessionStart,
  log,
});

/** Runs the sequence against fresh fakes and a recording logger. */
const run = async (
  setup: FakeSetup = {},
  over: Parameters<typeof input>[1] = {},
) => {
  const fake = fakeDeps(setup);
  const { warnings, log } = recordingLogger();
  const outcome = await retrieveForPrompt(input(log, over), fake.deps);
  return { fake, warnings, outcome };
};

const expectOneWarning = (warnings: unknown[][], text: string) => {
  expect(warnings).toHaveLength(1);
  expect(JSON.stringify(warnings[0])).toContain(text);
};

describe("retrieveForPrompt", () => {
  test("retrieves with the project, seen rows, names and embedder, closes, then records", async () => {
    const retrieved = result({
      contextBlock: BLOCK,
      memoryCount: 1,
      injectedIds: ["memory:new"],
    });
    const { fake, warnings, outcome } = await run({
      seen: new Set(["memory:seen"]),
      retrieved,
    });

    expect(outcome).toEqual({
      status: "retrieved",
      projectId: PROJECT,
      result: retrieved,
    });
    expect(fake.projectCalls).toEqual([CWD]);
    const call = onlyRetrieveCall(fake);
    expect(call.replica).toBe(fake.replica);
    expect(call.prompt).toBe(PROMPT);
    expect(call.options).toEqual({
      projectId: PROJECT,
      exclude: new Set(["memory:seen"]),
      projectNames: PROJECT_NAMES,
      sessionStart: false,
      summaryPending: false,
      embedQuery: fake.embedQuery,
    });
    expect(call.options?.embedQuery).toBe(fake.embedQuery);
    expect(fake.recorded).toEqual([[SESSION, ["memory:new"]]]);
    const after = fake.events.slice(fake.events.indexOf("retrieve"));
    expect(after).toEqual(["retrieve", "close", `record:${SESSION}`]);
    expect(warnings).toEqual([]);
  });

  test("an unresolved project is passed to retrieval as no project", async () => {
    const { fake, outcome } = await run({ projectId: null });

    expect(outcome).toEqual({
      status: "retrieved",
      projectId: null,
      result: result(),
    });
    expect(onlyRetrieveCall(fake).options?.projectId).toBeUndefined();
  });

  test("an unopenable replica is unavailable, warned once, and nothing else runs", async () => {
    const { fake, warnings, outcome } = await run(
      { openFails: true },
      { sessionStart: true, windowReset: true },
    );

    expect(outcome).toEqual({ status: "unavailable" });
    expect(fake.events).toEqual(["open"]);
    expectOneWarning(warnings, "disk is gone");
  });

  test("a failed retrieval is failed, warned once, closes the replica once, records nothing", async () => {
    const { fake, warnings, outcome } = await run({ retrieveFails: true });

    expect(outcome).toEqual({ status: "failed" });
    expect(fake.events.filter((e) => e === "close")).toHaveLength(1);
    expect(fake.recorded).toEqual([]);
    expectOneWarning(warnings, "vector index corrupt");
  });

  describe("seen rows", () => {
    test("a window reset clears the session's rows before reading them", async () => {
      const { fake } = await run({}, { windowReset: true });

      const clearAt = fake.events.indexOf(`clear:${SESSION}`);
      expect(clearAt).toBeGreaterThanOrEqual(0);
      expect(fake.events.indexOf(`read:${SESSION}`)).toBeGreaterThan(clearAt);
    });

    test("without a window reset nothing is cleared", async () => {
      const { fake } = await run({}, { windowReset: false });

      expect(fake.events).toContain(`read:${SESSION}`);
      expect(fake.events).not.toContain(`clear:${SESSION}`);
    });

    test("with no session id no state is touched and nothing is excluded", async () => {
      const { fake, outcome } = await run(
        {
          retrieved: result({ contextBlock: BLOCK, injectedIds: ["memory:x"] }),
        },
        { noSession: true, windowReset: true },
      );

      expect(outcome.status).toBe("retrieved");
      const stateEvents = fake.events.filter((e) =>
        /^(read|clear|record):/.test(e),
      );
      expect(stateEvents).toEqual([]);
      expect(onlyRetrieveCall(fake).options?.exclude).toEqual(new Set());
    });

    test("an unreadable state is warned once, excludes nothing, and retrieval still runs", async () => {
      const { fake, warnings, outcome } = await run({ readFails: true });

      expect(outcome.status).toBe("retrieved");
      expect(onlyRetrieveCall(fake).options?.exclude).toEqual(new Set());
      expectOneWarning(warnings, "state unreadable");
    });

    test("a failed clear is warned once, excludes nothing, and retrieval still runs", async () => {
      const { fake, warnings, outcome } = await run(
        { clearFails: true, seen: new Set(["memory:seen"]) },
        { windowReset: true },
      );

      expect(outcome.status).toBe("retrieved");
      expect(onlyRetrieveCall(fake).options?.exclude).toEqual(new Set());
      expectOneWarning(warnings, "state unclearable");
    });
  });

  describe("summary pending", () => {
    test("a first prompt checks the project's mark now and passes it to retrieval", async () => {
      const before = Date.now();
      const { fake } = await run({ pending: true }, { sessionStart: true });

      expect(fake.pendingCalls).toHaveLength(1);
      const [call] = fake.pendingCalls;
      if (call === undefined) throw new Error("the mark was never checked");
      const [projectId, now] = call;
      expect(projectId).toBe(PROJECT);
      expect(now).toBeGreaterThanOrEqual(before);
      expect(now).toBeLessThanOrEqual(Date.now());
      const options = onlyRetrieveCall(fake).options;
      expect(options?.sessionStart).toBe(true);
      expect(options?.summaryPending).toBe(true);
    });

    test("a first prompt with no pending mark is not deferred", async () => {
      const { fake } = await run({ pending: false }, { sessionStart: true });

      const options = onlyRetrieveCall(fake).options;
      expect(options?.sessionStart).toBe(true);
      expect(options?.summaryPending).toBe(false);
    });

    test("a later prompt does not check the mark", async () => {
      for (const sessionStart of [false, undefined]) {
        const { fake } = await run({ pending: true }, { sessionStart });

        expect(fake.pendingCalls).toEqual([]);
        const options = onlyRetrieveCall(fake).options;
        expect(options?.sessionStart).toBe(false);
        expect(options?.summaryPending).toBe(false);
      }
    });

    test("an unresolved project does not check the mark", async () => {
      const { fake } = await run(
        { projectId: null, pending: true },
        { sessionStart: true },
      );

      expect(fake.pendingCalls).toEqual([]);
      expect(onlyRetrieveCall(fake).options?.summaryPending).toBe(false);
    });

    test("an unreadable mark is warned once and counts as not pending", async () => {
      const { fake, warnings, outcome } = await run(
        { pendingFails: true },
        { sessionStart: true },
      );

      expect(outcome.status).toBe("retrieved");
      expect(onlyRetrieveCall(fake).options?.summaryPending).toBe(false);
      expectOneWarning(warnings, "mark unreadable");
    });
  });

  describe("recording", () => {
    test("an empty block records nothing", async () => {
      const { fake } = await run({
        retrieved: result({ injectedIds: ["memory:x"] }),
      });

      expect(fake.recorded).toEqual([]);
    });

    test("a failed record is warned once and the outcome is still retrieved", async () => {
      const retrieved = result({ contextBlock: BLOCK, injectedIds: ["m:x"] });
      const { warnings, outcome } = await run({
        recordFails: true,
        retrieved,
      });

      expect(outcome).toEqual({
        status: "retrieved",
        projectId: PROJECT,
        result: retrieved,
      });
      expectOneWarning(warnings, "state unwritable");
    });
  });
});

const ACTIVE = { projectId: PROJECT };
const COUNTED = { contextBlock: BLOCK, memoryCount: 2, summaryCount: 1 };
const RETRIEVED_STATUS = "↻ Retrieved 2 memories / 1 summaries (local)";
const EMBEDDER_STATUS = "↻ Retrieval skipped: the embedder gave no vector";
const PENDING_NOTE = "last session's summary is still generating";
const PENDING_STATUS = "↻ Last session's summary is still generating";
const injection = (additionalContext: string) => ({
  hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext },
});
const PREFIXED = injection(`<active_project id="${PROJECT}" />\n${BLOCK}`);

describe("promptContextOutput", () => {
  test("injects the block under the active project with the retrieval count", () => {
    const out = promptContextOutput(result(COUNTED), ACTIVE);
    expect(out).toEqual({ ...PREFIXED, systemMessage: RETRIEVED_STATUS });
    expect(out !== null && "summaryPending" in out).toBe(false);
  });

  test("an unresolved project injects the block without a prefix", () => {
    expect(promptContextOutput(result(COUNTED), { projectId: null })).toEqual({
      ...injection(BLOCK),
      systemMessage: RETRIEVED_STATUS,
    });
  });

  test("a deferred summary with a block joins the note to the count and is flagged", () => {
    expect(
      promptContextOutput(
        result({ ...COUNTED, summaryDeferred: true }),
        ACTIVE,
      ),
    ).toEqual({
      ...PREFIXED,
      systemMessage: `${RETRIEVED_STATUS} · ${PENDING_NOTE}`,
      summaryPending: true,
    });
  });

  test("a deferred summary with nothing to inject stands alone and is flagged", () => {
    const out = promptContextOutput(result({ summaryDeferred: true }), ACTIVE);
    expect(out).toEqual({
      systemMessage: PENDING_STATUS,
      summaryPending: true,
    });
    expect(out !== null && "hookSpecificOutput" in out).toBe(false);
  });

  test("a missing embedder says so, with no block", () => {
    const out = promptContextOutput(
      result({ embedderUnavailable: true }),
      ACTIVE,
    );
    expect(out).toEqual({ systemMessage: EMBEDDER_STATUS });
    expect(out !== null && "hookSpecificOutput" in out).toBe(false);
  });

  test("a missing embedder with a deferred summary joins the note", () => {
    expect(
      promptContextOutput(
        result({ embedderUnavailable: true, summaryDeferred: true }),
        ACTIVE,
      ),
    ).toEqual({
      systemMessage: `${EMBEDDER_STATUS} · ${PENDING_NOTE}`,
      summaryPending: true,
    });
  });

  test("a missing embedder outranks the count when a block came back anyway", () => {
    expect(
      promptContextOutput(
        result({ ...COUNTED, embedderUnavailable: true }),
        ACTIVE,
      ),
    ).toEqual({ ...PREFIXED, systemMessage: EMBEDDER_STATUS });
  });

  test("nothing to inject and nothing deferred prints nothing", () => {
    expect(promptContextOutput(result(), ACTIVE)).toBeNull();
  });
});
