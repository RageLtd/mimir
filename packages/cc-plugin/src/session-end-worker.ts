/**
 * The detached half of `mimir-cc session-end` (`session-end --worker
 * <file>`): reads the hand-off the runner wrote, then summarises the named
 * session's uncovered journal against the configured extraction endpoint
 * with the project's summary marked in flight, settles the journal on a
 * stored summary, clears the mark with its owner token, and syncs a stored
 * row. See session-end-hook.ts for the whole flow.
 */

import type { ModelMessage } from "@ai-sdk/provider-utils";
import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import { summarizeToReplica } from "@mimir/plugin-core/brain/summarize";
import { getOrResolveProjectId } from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import {
  createOrgReplica,
  defaultOrgReplicaPath,
} from "@mimir/plugin-core/store/org-replica";
import {
  clearSummaryPending,
  markSummaryPending,
} from "@mimir/plugin-core/summary-pending";
import { syncAfterDistill } from "@mimir/plugin-core/sync/after-distill";
import { extractionConfig, readConfig } from "./config";
import { createLogger } from "./logger";
import { readHandOff, type WorkerInput } from "./session-end-handoff";
import { readSummaryInput, settleJournal } from "./session-journal";

const log = createLogger("session-end-hook");

export type Log = {
  readonly info: (msg: string, data?: Record<string, unknown>) => void;
  readonly warn: (msg: string, data?: Record<string, unknown>) => void;
};

/** The project's mark and its owner token, or none if marking failed. */
export const markFor = async (
  projectId: string,
  deps: {
    readonly markPending: (projectId: string) => Promise<string>;
    readonly log: Log;
  },
) => {
  const [markErr, token] = await attempt(() => deps.markPending(projectId));
  if (!markErr) return token;
  deps.log.warn("session-end: could not mark the summary in flight", {
    projectId,
    error: markErr.message,
  });
  return null;
};

/** A summarise op's result; `text` is what a stored summary settles with. */
type SummaryOutcome = {
  readonly ok: boolean;
  readonly id: string | null;
  readonly skipped: string | null;
  readonly text?: string | null;
};

type WorkerOps = {
  readonly resolveProjectId: (cwd: string) => Promise<string | null>;
  readonly markPending: (projectId: string) => Promise<string>;
  readonly clearPending: (projectId: string, token: string) => Promise<unknown>;
  readonly summarize: (
    messages: readonly ModelMessage[],
    projectId: string,
  ) => Promise<SummaryOutcome>;
  readonly sync: () => Promise<unknown>;
  readonly log: Log;
};

/** The project the hand-off names, or the one its cwd resolves to. */
const workerProjectId = async (input: WorkerInput, ops: WorkerOps) => {
  if (input.projectId !== undefined) return input.projectId;
  const cwd = input.cwd;
  if (cwd === undefined) {
    ops.log.warn("session-end: hand-off names neither a project nor a cwd", {
      sessionId: input.sessionId,
    });
    return null;
  }
  const [err, projectId] = await attempt(() => ops.resolveProjectId(cwd));
  if (err || !projectId) {
    ops.log.warn("session-end: no project id — session not summarised", {
      cwd,
      ...(err ? { error: err.message } : {}),
    });
    return null;
  }
  return projectId;
};

/**
 * Summarise the session's uncovered journal, settling it on a stored
 * summary; null when there is nothing to summarise or the journal could not
 * be read (logged there).
 */
const summariseJournal = async (
  sessionId: string,
  projectId: string,
  ops: WorkerOps,
) => {
  const journal = readSummaryInput(sessionId);
  if (journal === null || journal.messages.length === 0) return null;
  const outcome = await ops.summarize(journal.messages, projectId);
  if (outcome.id !== null && outcome.text) {
    settleJournal(sessionId, journal.cursor, outcome.text);
  }
  return { ...outcome, messages: journal.messages.length };
};

/**
 * Summarise with the project marked in flight throughout — by the runner,
 * whose token it is handed, or by the worker itself. The mark clears with
 * its owner's token however the summary ends, and only a stored row syncs.
 * Never throws.
 */
export const runSessionEndWorker = async (
  input: WorkerInput,
  ops: WorkerOps,
) => {
  const { sessionId } = input;
  const projectId = await workerProjectId(input, ops);
  if (projectId === null) return 0;
  const token = input.token ?? (await markFor(projectId, ops));
  const [summaryErr, outcome] = await attempt(() =>
    summariseJournal(sessionId, projectId, ops),
  );
  if (token !== null) {
    const [clearErr] = await attempt(() => ops.clearPending(projectId, token));
    if (clearErr) {
      ops.log.warn("session-end: could not clear the in-flight mark", {
        projectId,
        error: clearErr.message,
      });
    }
  }
  if (summaryErr) {
    ops.log.warn("session-end: summarization threw", {
      sessionId,
      projectId,
      error: summaryErr.message,
    });
    return 0;
  }
  if (outcome === null) {
    ops.log.info("session-end: nothing uncovered in the session journal", {
      sessionId,
      projectId,
    });
    return 0;
  }
  if (!outcome.ok) {
    ops.log.warn("session-end: summarization failed", {
      sessionId,
      projectId,
      messages: outcome.messages,
    });
    return 0;
  }
  if (outcome.id === null) {
    ops.log.info("session-end: summary skipped", {
      sessionId,
      projectId,
      reason: outcome.skipped,
    });
    return 0;
  }
  ops.log.info("session-end: session summarised", {
    sessionId,
    projectId,
    summaryId: outcome.id,
    messages: outcome.messages,
  });
  const [syncErr] = await attempt(ops.sync);
  if (syncErr) {
    ops.log.warn("session-end: post-summary sync failed", {
      error: syncErr.message,
    });
  }
  return 0;
};

/** The real summarise op: the configured endpoint, into the local replica. */
const summarize = async (
  messages: readonly ModelMessage[],
  projectId: string,
) => {
  const extraction = await extractionConfig();
  if (!extraction) return { ok: false, id: null, skipped: null };
  const replica = createOrgReplica(
    process.env.MIMIR_ORG_REPLICA_DB ?? defaultOrgReplicaPath(),
  );
  return summarizeToReplica({
    config: extraction,
    replica,
    messages,
    embed: createEmbedQuery(),
    projectId,
  }).finally(() => replica.close());
};

/** The full resolution, git and all: the worker has the time for it. */
const resolveProjectId = async (cwd: string) => {
  const config = await readConfig();
  return config
    ? getOrResolveProjectId(config.serverUrl, cwd, config.apiKey)
    : null;
};

const workerOps = {
  resolveProjectId,
  markPending: (projectId: string) => markSummaryPending(projectId),
  clearPending: (projectId: string, token: string) =>
    clearSummaryPending(projectId, token),
  summarize,
  sync: () => syncAfterDistill(log),
  log,
} satisfies WorkerOps;

/** The worker's entry: read and remove the hand-off file, then run. */
export const runWorker = async (path: string) => {
  const [err, input] = await attempt(() => readHandOff(path));
  if (err) {
    log.warn("session-end: could not read the hand-off file", {
      path,
      error: err.message,
    });
    return 0;
  }
  return runSessionEndWorker(input, workerOps);
};
