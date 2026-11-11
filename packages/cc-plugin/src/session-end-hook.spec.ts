/**
 * Tests for `mimir-cc session-end`: `sessionEndPlan`, the pure decision
 * over the ending session's window; `runSessionEndHook`, the runner that
 * decides and detaches; and `runSessionEndWorker`, the detached worker
 * that summarises. The project's summary is marked in flight from before
 * the runner returns until the worker is done, so the next session's first
 * retrieve can tell a summary is still coming. A mark is owned: it clears
 * only with the token its `markPending` returned.
 */

import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { ExtractionConfig } from "@mimir/plugin-core/brain/extract";
import { type ApiMessage, toModelMessages } from "./conversation";
import {
  runSessionEndHook,
  runSessionEndWorker,
  sessionEndPlan,
} from "./session-end-hook";

const BYOK: ExtractionConfig = {
  baseUrl: "http://localhost:11434/v1",
  model: "llama3",
};

const user = (content: string): ModelMessage => ({ role: "user", content });
const assistant = (content: string): ModelMessage => ({
  role: "assistant",
  content,
});

const LINES = [
  "We decided the sync relay stays blind: the server never parses memory content, only ciphertext.",
  "Understood. Extraction and embeddings therefore run client-side, and the server only distributes wrapped keys.",
  "Right, and the cc-plugin should use Haiku through the session's own client when no endpoint is configured.",
  "Noted: a configured extraction endpoint and model win when present; otherwise Haiku via the session client.",
];

// Well over the 400-char summary floor.
const LONG: ModelMessage[] = LINES.map((line, i) =>
  i % 2 === 0 ? user(line) : assistant(line),
);

/** LONG as the hooks module sends it: api-shaped blocks. */
const LONG_API: ApiMessage[] = LINES.map((text, i) => ({
  role: i % 2 === 0 ? "user" : "assistant",
  content: [{ type: "text", text }],
}));

// Under the floor.
const SHORT: ModelMessage[] = [user("hi")];
const SHORT_API: ApiMessage[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
];

const PROJECT = "project:abc";
const CWD = "/work/repo";
const SESSION = "session-1";
const TOKEN = "owner-1";
const EXTRACTION_SETTING = "MIMIR_EXTRACTION_BASE_URL";

describe("sessionEndPlan", () => {
  test("an empty window skips, with a reason", () => {
    const plan = sessionEndPlan({ window: [], extraction: BYOK });
    expect(plan.kind).toBe("skip");
    expect("reason" in plan && typeof plan.reason).toBe("string");
  });

  test("a window under the summary floor skips with the floor's reason", () => {
    for (const extraction of [BYOK, null]) {
      const plan = sessionEndPlan({ window: SHORT, extraction });
      expect(plan.kind).toBe("skip");
      expect("reason" in plan ? plan.reason : "").toContain("window too small");
    }
  });

  test("no extraction endpoint leaves a summarisable window unconfigured", () => {
    expect(sessionEndPlan({ window: LONG, extraction: null })).toEqual({
      kind: "unconfigured",
    });
  });

  test("an endpoint and a summarisable window summarise", () => {
    expect(sessionEndPlan({ window: LONG, extraction: BYOK })).toEqual({
      kind: "summarise",
    });
  });
});

type Logged = { readonly msg: string; readonly data?: Record<string, unknown> };

const recordingLog = () => {
  const info: Logged[] = [];
  const warn: Logged[] = [];
  const error: Logged[] = [];
  return {
    info,
    warn,
    error,
    log: {
      info: (msg: string, data?: Record<string, unknown>) =>
        info.push({ msg, data }),
      warn: (msg: string, data?: Record<string, unknown>) =>
        warn.push({ msg, data }),
      error: (msg: string, data?: Record<string, unknown>) =>
        error.push({ msg, data }),
    },
  };
};

type SweepOutcome = {
  readonly removed: number;
  readonly failures: readonly {
    readonly path: string;
    readonly error: string;
  }[];
};

const SWEPT: SweepOutcome = { removed: 3, failures: [] };
const SWEEP = "sweep";

/** The runner's deps, recording each call in `order`. */
const runner = (options: {
  readonly extraction?: ExtractionConfig | null;
  readonly cached?: string | null;
  readonly spawn?: () => void | Promise<void>;
  readonly sweep?: () => Promise<SweepOutcome>;
}) => {
  const order: string[] = [];
  const spawned: unknown[] = [];
  const sweptAt: number[] = [];
  const logs = recordingLog();
  return {
    order,
    spawned,
    sweptAt,
    logs,
    deps: {
      sweepFileContextState: async (now: number) => {
        order.push(SWEEP);
        sweptAt.push(now);
        return options.sweep ? options.sweep() : SWEPT;
      },
      extraction: options.extraction === undefined ? BYOK : options.extraction,
      cachedProjectId: async (cwd: string) => {
        order.push(`cached:${cwd}`);
        return options.cached === undefined ? PROJECT : options.cached;
      },
      markPending: async (projectId: string) => {
        order.push(`mark:${projectId}`);
        return TOKEN;
      },
      clearPending: async (projectId: string, token: string) => {
        order.push(`clear:${projectId}:${token}`);
      },
      spawnWorker: async (handOff: unknown) => {
        order.push("spawn");
        spawned.push(handOff);
        await options.spawn?.();
      },
      log: logs.log,
    },
  };
};

const ending = (window: readonly ApiMessage[] = LONG_API) => ({
  session_id: SESSION,
  cwd: CWD,
  reason: "prompt_input_exit",
  window,
});

describe("runSessionEndHook", () => {
  test("with a cached project id, the mark is set before the worker spawns, and the worker gets the id and the owner token", async () => {
    const { order, spawned, deps } = runner({});
    const code = await runSessionEndHook(ending(), deps);
    order.push("resolved");

    expect(code).toBe(0);
    const mark = order.indexOf(`mark:${PROJECT}`);
    expect(mark).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("spawn")).toBeGreaterThan(mark);
    expect(order.indexOf("resolved")).toBeGreaterThan(mark);
    expect(order.filter((step) => step.startsWith("mark:"))).toHaveLength(1);
    expect(order.some((step) => step.startsWith("clear:"))).toBe(false);
    expect(spawned).toEqual([
      {
        projectId: PROJECT,
        token: TOKEN,
        window: toModelMessages(LONG_API),
      },
    ]);
  });

  test("with no cached project id, the runner sets no mark and hands the worker the cwd to resolve", async () => {
    const { order, spawned, deps } = runner({ cached: null });
    const code = await runSessionEndHook(ending(), deps);

    expect(code).toBe(0);
    expect(order).toEqual([`cached:${CWD}`, "spawn", SWEEP]);
    expect(spawned).toEqual([{ cwd: CWD, window: toModelMessages(LONG_API) }]);
  });

  test("unconfigured: one warning naming the extraction endpoint setting; no mark, no spawn", async () => {
    const { order, logs, deps } = runner({ extraction: null });
    const code = await runSessionEndHook(ending(), deps);

    expect(code).toBe(0);
    expect(logs.warn).toHaveLength(1);
    expect(logs.warn[0]?.msg).toContain(EXTRACTION_SETTING);
    expect(order.some((step) => step.startsWith("mark:"))).toBe(false);
    expect(order).not.toContain("spawn");
  });

  test("skip: an info line with the reason; no mark, no spawn", async () => {
    const { order, logs, deps } = runner({});
    const code = await runSessionEndHook(ending([]), deps);

    expect(code).toBe(0);
    expect(logs.warn).toEqual([]);
    expect(logs.info.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs.info)).toContain("empty window");
    expect(order.some((step) => step.startsWith("mark:"))).toBe(false);
    expect(order).not.toContain("spawn");
  });

  test("a failed hand-off clears the runner's own mark with its token, warns, and still resolves", async () => {
    const { order, logs, deps } = runner({
      spawn: () => {
        throw new Error("EACCES");
      },
    });
    const code = await runSessionEndHook(ending(), deps);

    expect(code).toBe(0);
    expect(order.indexOf(`clear:${PROJECT}:${TOKEN}`)).toBeGreaterThan(
      order.indexOf("spawn"),
    );
    expect(logs.warn.length).toBeGreaterThan(0);
  });
});

/** Every way a session can end, as the runner sees it. */
const ENDINGS = [
  ["summarise, cached project", {}, LONG_API],
  ["summarise, no cached project", { cached: null }, LONG_API],
  ["unconfigured", { extraction: null }, LONG_API],
  ["skip, empty window", {}, []],
  ["skip, window under the floor", {}, SHORT_API],
  [
    "failed hand-off",
    {
      spawn: () => {
        throw new Error("EACCES");
      },
    },
    LONG_API,
  ],
] satisfies readonly (readonly [
  string,
  Parameters<typeof runner>[0],
  readonly ApiMessage[],
])[];

describe("runSessionEndHook sweeps the file-context state", () => {
  for (const [what, options, window] of ENDINGS) {
    test(`${what}: the sweep runs once, at the current time, and a clean sweep logs no error`, async () => {
      const { order, sweptAt, logs, deps } = runner(options);
      const before = Date.now();
      const code = await runSessionEndHook(ending(window), deps);
      const after = Date.now();

      expect(code).toBe(0);
      expect(order.filter((step) => step === SWEEP)).toHaveLength(1);
      expect(sweptAt).toHaveLength(1);
      expect(sweptAt[0]).toBeGreaterThanOrEqual(before);
      expect(sweptAt[0]).toBeLessThanOrEqual(after);
      expect(logs.error).toEqual([]);
    });

    for (const [failure, sweep] of [
      [
        "rejects",
        async () => {
          throw new Error("EIO");
        },
      ],
      [
        "reports failures",
        async () => ({
          removed: 1,
          failures: [{ path: "/state/sess-x", error: "EACCES" }],
        }),
      ],
    ] satisfies readonly (readonly [string, () => Promise<SweepOutcome>])[]) {
      test(`${what}: a sweep that ${failure} leaves the outcome unchanged and logs one error`, async () => {
        const clean = runner(options);
        const cleanCode = await runSessionEndHook(ending(window), clean.deps);
        const failing = runner({ ...options, sweep });
        const failingCode = await runSessionEndHook(
          ending(window),
          failing.deps,
        );

        expect(failingCode).toBe(cleanCode);
        expect(failing.order).toEqual(clean.order);
        expect(failing.spawned).toEqual(clean.spawned);
        expect(failing.logs.warn).toEqual(clean.logs.warn);
        expect(failing.logs.error).toHaveLength(1);
      });
    }
  }

  // The hook shares a 1.5 s bound: a slow sweep must never cost the summary.
  for (const [what, options, window] of ENDINGS.filter(([name]) =>
    name.startsWith("summarise"),
  )) {
    test(`${what}: the worker is handed the summary before the sweep starts`, async () => {
      const { order, deps } = runner(options);
      await runSessionEndHook(ending(window), deps);

      const sweep = order.indexOf(SWEEP);
      expect(sweep).toBeGreaterThanOrEqual(0);
      expect(order.indexOf("spawn")).toBeGreaterThanOrEqual(0);
      expect(order.indexOf("spawn")).toBeLessThan(sweep);
    });

    test(`${what}: a sweep that never settles does not stop the hand-off`, async () => {
      const pending = Promise.withResolvers<SweepOutcome>();
      const { order, deps } = runner({
        ...options,
        sweep: () => pending.promise,
      });
      const run = runSessionEndHook(ending(window), deps);
      await Bun.sleep(10);
      const seen = [...order];

      // Settle the sweep before asserting, so no hanging promise outlives the test.
      pending.resolve(SWEPT);
      await run;

      expect(seen).toContain(SWEEP);
      expect(seen).toContain("spawn");
    });
  }
});

type Outcome = {
  readonly ok: boolean;
  readonly id: string | null;
  readonly skipped: string | null;
};

const STORED: Outcome = { ok: true, id: "memory:1", skipped: null };
const FAILED: Outcome = { ok: false, id: null, skipped: null };
const MARKED = "marked-1";

/** The worker's ops, recording each call in `order`. */
const ops = (summarize: () => Promise<Outcome>, resolved = PROJECT) => {
  const order: string[] = [];
  const logs = recordingLog();
  return {
    order,
    logs,
    ops: {
      resolveProjectId: async (cwd: string) => {
        order.push(`resolve:${cwd}`);
        return resolved;
      },
      markPending: async (projectId: string) => {
        order.push(`mark:${projectId}`);
        return MARKED;
      },
      clearPending: async (projectId: string, token: string) => {
        order.push(`clear:${projectId}:${token}`);
      },
      summarize: async (window: readonly ModelMessage[]) => {
        order.push(`summarize:${window.length}`);
        return summarize();
      },
      sync: async () => {
        order.push("sync");
        return { status: "ok" };
      },
      log: logs.log,
    },
  };
};

const CLEARED_OWN = `clear:${PROJECT}:${MARKED}`;

describe("runSessionEndWorker", () => {
  test("marks the summary in flight before summarising and clears it with its own token after the row is stored", async () => {
    const { order, ops: worker } = ops(async () => STORED);
    await runSessionEndWorker({ projectId: PROJECT, window: LONG }, worker);
    const mark = order.indexOf(`mark:${PROJECT}`);
    const summarize = order.indexOf(`summarize:${LONG.length}`);
    const clear = order.indexOf(CLEARED_OWN);
    expect(mark).toBeGreaterThanOrEqual(0);
    expect(summarize).toBeGreaterThan(mark);
    expect(clear).toBeGreaterThan(summarize);
  });

  test("given the runner's owner token, it does not mark again and clears with that token", async () => {
    const { order, ops: worker } = ops(async () => STORED);
    await runSessionEndWorker(
      { projectId: PROJECT, token: TOKEN, window: LONG },
      worker,
    );
    expect(order.some((step) => step.startsWith("mark:"))).toBe(false);
    expect(order.indexOf(`clear:${PROJECT}:${TOKEN}`)).toBeGreaterThan(
      order.indexOf(`summarize:${LONG.length}`),
    );
    expect(order).not.toContain(CLEARED_OWN);
  });

  test("given only a cwd, it resolves the project, marks it, and clears with the token the mark returned", async () => {
    const { order, ops: worker } = ops(async () => STORED);
    await runSessionEndWorker({ cwd: CWD, window: LONG }, worker);
    const resolve = order.indexOf(`resolve:${CWD}`);
    const mark = order.indexOf(`mark:${PROJECT}`);
    expect(resolve).toBeGreaterThanOrEqual(0);
    expect(mark).toBeGreaterThan(resolve);
    expect(order.indexOf(`summarize:${LONG.length}`)).toBeGreaterThan(mark);
    expect(order.indexOf(CLEARED_OWN)).toBeGreaterThan(mark);
  });

  test("malformed input — no project id and no cwd — warns and does nothing", async () => {
    const { order, logs, ops: worker } = ops(async () => STORED);
    const code = await runSessionEndWorker({ window: LONG }, worker);
    expect(code).toBe(0);
    expect(order).toEqual([]);
    expect(logs.warn.length).toBeGreaterThan(0);
  });

  test("a failed summary still clears the mark", async () => {
    const { order, ops: worker } = ops(async () => FAILED);
    await runSessionEndWorker({ projectId: PROJECT, window: LONG }, worker);
    expect(order.indexOf(CLEARED_OWN)).toBeGreaterThan(
      order.indexOf(`summarize:${LONG.length}`),
    );
  });

  test("a summary that throws still clears the mark, and the worker does not throw", async () => {
    const { order, ops: worker } = ops(async () => {
      throw new Error("endpoint unreachable");
    });
    await runSessionEndWorker({ projectId: PROJECT, window: LONG }, worker);
    expect(order).toContain(CLEARED_OWN);
    expect(order).not.toContain("sync");
  });

  test("a stored summary syncs afterwards; a failed one does not", async () => {
    const stored = ops(async () => STORED);
    await runSessionEndWorker({ projectId: PROJECT, window: LONG }, stored.ops);
    expect(stored.order.indexOf("sync")).toBeGreaterThan(
      stored.order.indexOf(`summarize:${LONG.length}`),
    );

    const failed = ops(async () => FAILED);
    await runSessionEndWorker({ projectId: PROJECT, window: LONG }, failed.ops);
    expect(failed.order).not.toContain("sync");
  });
});
