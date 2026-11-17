/**
 * `mimir-cc session-end` — run by the hooks module on `session.end` with
 * `{ session_id, cwd, reason, messages }`: the undistilled tail of the
 * session that is ending. The runner appends it to the session journal
 * (session-journal.ts), and the journal's uncovered messages — led by the
 * previous summary when one was carried, as `precompact` builds it — are
 * summarised into a type:"summary" replica memory so the next session picks
 * up the narrative. A stored summary settles the journal; nothing here drops
 * it. A `window` in the payload is ignored.
 *
 * The engine's `session.end` chain shares one short wall-clock bound, so
 * the runner (`runSessionEndHook`) only journals, decides
 * (`sessionEndPlan`) and, to summarise, names the session to a detached
 * worker through a private file (session-end-handoff.ts) that carries no
 * conversation text, and returns. Nothing slow runs before it does:
 * the project id is read from the cache alone — no git, no network. With
 * a cached id the runner marks the project's summary in flight
 * (summary-pending) before the worker is spawned, and hands the worker the
 * mark's owner token; without one it hands over the cwd, and the worker
 * (`runSessionEndWorker`, session-end-worker.ts) resolves the project and
 * sets the mark itself. Either way the worker reads the session's journal,
 * summarises against the configured extraction endpoint, settles the
 * journal on a stored summary, clears the mark with its token, and syncs a
 * stored row. The mark is for the next session's first retrieve, which
 * reads it in a later change; nothing reads it yet.
 *
 * There is no session-model path here: the session is gone before a
 * completion could come back, so without an extraction endpoint the
 * journal goes unsummarised, with a warning. Every outcome is logged; exit 0.
 */

import type { ModelMessage } from "@ai-sdk/provider-utils";
import type { ExtractionConfig } from "@mimir/plugin-core/brain/extract";
import { prepareSummary } from "@mimir/plugin-core/brain/summarize";
import { getCachedProjectId } from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import {
  clearSummaryPending,
  markSummaryPending,
} from "@mimir/plugin-core/summary-pending";
import { extractionConfig } from "./config";
import type { ApiMessage } from "./conversation";
import {
  type FileContextSweepOutcome,
  sweepFileContextState,
} from "./file-context-sweep";
import { createLogger } from "./logger";
import {
  spawnWorker,
  WORKER_FLAG,
  type WorkerInput,
} from "./session-end-handoff";
import { type Log, markFor, runWorker } from "./session-end-worker";
import { journalMessages, readSummaryInput } from "./session-journal";

export {
  HANDOFF_SWEEP_MS,
  readHandOff,
  writeHandOff,
} from "./session-end-handoff";
export { runSessionEndWorker } from "./session-end-worker";

const log = createLogger("session-end-hook");

type SessionEndInput = {
  readonly session_id?: string;
  readonly cwd?: string;
  readonly reason?: string;
  readonly messages?: readonly ApiMessage[];
};

/**
 * What this run does with the ending session's summary input (`window`,
 * the journal as `readSummaryInput` builds it): nothing to say skips, a
 * window under the summary floor skips with the floor's reason, no
 * extraction endpoint leaves it unconfigured, otherwise summarise.
 */
export const sessionEndPlan = (input: {
  readonly window: readonly ModelMessage[];
  readonly extraction: ExtractionConfig | null;
}) => {
  if (input.window.length === 0) {
    return { kind: "skip" as const, reason: "empty window" };
  }
  const summary = prepareSummary(input.window);
  if ("skipped" in summary) {
    return { kind: "skip" as const, reason: summary.skipped };
  }
  if (!input.extraction) return { kind: "unconfigured" as const };
  return { kind: "summarise" as const };
};

type HookDeps = {
  readonly extraction: ExtractionConfig | null;
  readonly cachedProjectId: (cwd: string) => Promise<string | null>;
  readonly markPending: (projectId: string) => Promise<string>;
  readonly clearPending: (projectId: string, token: string) => Promise<unknown>;
  readonly spawnWorker: (handOff: WorkerInput) => Promise<unknown>;
  readonly sweepFileContextState: (
    now: number,
  ) => Promise<FileContextSweepOutcome>;
  readonly log: Log & {
    readonly error: (msg: string, data?: Record<string, unknown>) => void;
  };
};

/**
 * Mark the summary in flight when the project id is cached, then spawn
 * the worker; a spawn that fails clears the runner's own mark.
 */
const handOffSummary = async (
  context: {
    readonly sessionId: string;
    readonly reason: string;
    readonly cwd: string;
    readonly window: readonly ModelMessage[];
  },
  deps: HookDeps,
) => {
  const { sessionId, reason, cwd, window } = context;
  const [cacheErr, cached] = await attempt(() => deps.cachedProjectId(cwd));
  if (cacheErr) {
    deps.log.warn("session-end: could not read the project id cache", {
      cwd,
      error: cacheErr.message,
    });
  }
  const projectId = cached ?? null;
  const token = projectId === null ? null : await markFor(projectId, deps);
  const handOff: WorkerInput =
    projectId === null
      ? { sessionId, cwd }
      : token === null
        ? { sessionId, projectId }
        : { sessionId, projectId, token };

  const [spawnErr] = await attempt(() => deps.spawnWorker(handOff));
  if (spawnErr) {
    deps.log.warn("session-end: could not hand the summary off", {
      sessionId,
      error: spawnErr.message,
    });
    if (projectId !== null && token !== null) {
      const [clearErr] = await attempt(() =>
        deps.clearPending(projectId, token),
      );
      if (clearErr) {
        deps.log.warn("session-end: could not clear the in-flight mark", {
          projectId,
          error: clearErr.message,
        });
      }
    }
    return 0;
  }
  deps.log.info("session-end: summary handed to a worker", {
    sessionId,
    reason,
    ...(projectId === null ? { cwd } : { projectId }),
    messages: window.length,
  });
  return 0;
};

const assertNever = (value: never) => {
  throw new Error(`Unhandled session-end plan: ${JSON.stringify(value)}`);
};

/** Journal the tail, decide, and to summarise, hand the session off. */
const endSession = async (input: SessionEndInput, deps: HookDeps) => {
  const sessionId = input.session_id;
  const reason = input.reason ?? "unknown";
  const cwd = input.cwd ?? process.cwd();
  if (sessionId === undefined) {
    deps.log.info("session-end: nothing to summarise", {
      reason,
      why: "no session_id in payload",
    });
    return 0;
  }
  journalMessages(sessionId, input.messages ?? []);
  // An unreadable journal (logged there) leaves nothing to summarise.
  const window = readSummaryInput(sessionId)?.messages ?? [];
  const plan = sessionEndPlan({ window, extraction: deps.extraction });

  switch (plan.kind) {
    case "skip":
      deps.log.info("session-end: nothing to summarise", {
        sessionId,
        reason,
        why: plan.reason,
      });
      return 0;
    case "unconfigured":
      deps.log.warn(
        "session-end: no extraction endpoint configured (MIMIR_EXTRACTION_BASE_URL / extractionBaseUrl) — session not summarised",
        { sessionId, reason, messages: window.length },
      );
      return 0;
    case "summarise":
      return handOffSummary({ sessionId, reason, cwd, window }, deps);
    default:
      return assertNever(plan);
  }
};

/** Prune the file-context state; a failed sweep is logged, never surfaced. */
const sweepState = async (deps: HookDeps) => {
  const [sweepErr, outcome] = await attempt(() =>
    deps.sweepFileContextState(Date.now()),
  );
  if (sweepErr) {
    deps.log.error("session-end: file-context sweep failed", {
      error: sweepErr.message,
    });
    return;
  }
  if (outcome.failures.length > 0) {
    deps.log.error("session-end: file-context sweep left entries behind", {
      removed: outcome.removed,
      failures: outcome.failures,
    });
  }
};

/**
 * The runner: end the session, then sweep. The sweep runs after the
 * hand-off so the chain's shared wall-clock bound never costs the summary.
 * Never throws.
 */
export const runSessionEndHook = async (
  input: SessionEndInput,
  deps: HookDeps,
) => {
  const code = await endSession(input, deps);
  await sweepState(deps);
  return code;
};

/**
 * The cache alone, keyed as `getOrResolveProjectId` writes it; an entry
 * that is not a local project id is one only full resolution may migrate.
 */
const cachedProjectId = async (cwd: string) => {
  const cached = await getCachedProjectId(cwd);
  return cached?.startsWith("project:") ? cached : null;
};

/** The hooks module's payload, or null when there is none to act on. */
const readInput = async () => {
  const [err, raw] = await attempt(() => Bun.stdin.text());
  if (err) {
    log.warn("session-end: could not read stdin", { error: err.message });
    return null;
  }
  if (raw.trim().length === 0) {
    log.warn("session-end: empty payload");
    return null;
  }
  const [parseErr, parsed] = await attempt(async () => {
    const value: unknown = JSON.parse(raw);
    return value;
  });
  if (parseErr) {
    log.warn("session-end: payload is not JSON", { error: parseErr.message });
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    log.warn("session-end: payload is not an object");
    return null;
  }
  // Serialisation boundary: the hooks module wrote this JSON.
  return parsed as SessionEndInput;
};

const runHook = async () => {
  const input = await readInput();
  if (input === null) return 0;
  return runSessionEndHook(input, {
    extraction: await extractionConfig(),
    cachedProjectId,
    markPending: (projectId) => markSummaryPending(projectId),
    clearPending: (projectId, token) => clearSummaryPending(projectId, token),
    spawnWorker,
    sweepFileContextState,
    log,
  });
};

/** Entry point from cli.ts; exit 0 whatever happens. */
export const runSessionEndCommand = async (args: readonly string[]) => {
  if (args[0] === WORKER_FLAG) {
    const path = args[1];
    if (!path) {
      log.warn("session-end: worker missing its hand-off file arg");
      return 0;
    }
    return runWorker(path);
  }
  if (process.env.MIMIR_ACTIVE !== "1") return 0;
  return runHook();
};
