/**
 * Retrieval for one developer prompt — the sequence every editor adapter's
 * UserPromptSubmit hook runs against the LOCAL org replica, and the map
 * from its result to what the hook prints.
 *
 * `retrieveForPrompt` opens the replica, resolves the active project,
 * reads the session's seen rows (clearing them first after a window
 * reset), checks the summary-pending mark on a session's first prompt,
 * retrieves, closes, and records what was injected. Every failure is
 * logged through the host's logger; only an unopenable replica or a failed
 * retrieval changes the outcome. Each host keeps its own gates (empty
 * prompt, first-prompt marker) and decides what a failure prints.
 */

import type { Logger } from "../logger";
import { activeProjectId } from "../project/active";
import { readProjectNames } from "../project/cache";
import { attempt } from "../result";
import {
  clearInjectedIds,
  readInjectedIds,
  recordInjectedIds,
} from "../retrieve-state";
import {
  createOrgReplica,
  defaultOrgReplicaPath,
  type OrgReplica,
} from "../store/org-replica";
import { isSummaryPending } from "../summary-pending";
import { errMessage } from "../util";
import { createEmbedQuery } from "./embedder";
import { type RetrievedContext, retrieveLocalContext } from "./retrieve";

/** Log fields name a session that has no id this way. */
const UNNAMED_SESSION = "default";

const EMBEDDER_UNAVAILABLE_STATUS =
  "↻ Retrieval skipped: the embedder gave no vector";
const SUMMARY_PENDING_STATUS = "↻ Last session's summary is still generating";
const SUMMARY_PENDING_NOTE = "last session's summary is still generating";

export type RetrievePromptDeps = {
  readonly openReplica: (path: string) => OrgReplica;
  readonly activeProjectId: typeof activeProjectId;
  readonly readInjectedIds: typeof readInjectedIds;
  readonly clearInjectedIds: typeof clearInjectedIds;
  readonly recordInjectedIds: typeof recordInjectedIds;
  readonly isSummaryPending: typeof isSummaryPending;
  readonly readProjectNames: typeof readProjectNames;
  readonly retrieveLocalContext: typeof retrieveLocalContext;
  readonly createEmbedQuery: typeof createEmbedQuery;
};

const defaultDeps: RetrievePromptDeps = {
  openReplica: createOrgReplica,
  activeProjectId,
  readInjectedIds,
  clearInjectedIds,
  recordInjectedIds,
  isSummaryPending,
  readProjectNames,
  retrieveLocalContext,
  createEmbedQuery,
};

export type RetrievePromptInput = {
  /** The session's id; without one no seen rows are read, cleared or
   *  recorded. */
  readonly sessionId: string | undefined;
  readonly cwd: string;
  /** The developer's prompt, already trimmed and non-empty. */
  readonly prompt: string;
  /** A compaction replaced the window, so its rows may be sent again. */
  readonly windowReset?: boolean;
  /** The session's first prompt: retrieval brings the active project's
   *  newest summary, or defers it while that summary is being written. */
  readonly sessionStart?: boolean;
  readonly log: Logger;
};

/**
 * Retrieval's options for one prompt, without the query embedder. Pure.
 * A pending summary means nothing to a later prompt; an unresolved
 * project is no project.
 */
const promptRetrieveOptions = (resolved: {
  readonly projectId: string | null;
  readonly exclude: ReadonlySet<string>;
  readonly projectNames: Readonly<Record<string, string>>;
  readonly sessionStart: boolean;
  readonly summaryPending: boolean;
}) => ({
  projectId: resolved.projectId ?? undefined,
  exclude: resolved.exclude,
  projectNames: resolved.projectNames,
  sessionStart: resolved.sessionStart,
  summaryPending: resolved.sessionStart && resolved.summaryPending,
});

/** Rows already in this session's context window, which are not sent
 *  again. An unreadable state skips nothing. */
const readSeen = async (
  input: RetrievePromptInput,
  deps: RetrievePromptDeps,
  logSessionId: string,
) => {
  const { sessionId } = input;
  const [err, seen] = await attempt(async () => {
    if (sessionId === undefined) return new Set<string>();
    // Done here, on the next prompt, because the precompact run is
    // detached and would race this read.
    if (input.windowReset === true) await deps.clearInjectedIds(sessionId);
    return deps.readInjectedIds(sessionId);
  });
  if (err) {
    input.log.warn(
      "retrieve state unreadable — nothing is skipped this prompt",
      { sessionId: logSessionId, error: err.message },
    );
  }
  return seen ?? new Set<string>();
};

/** Whether the last session's summary is still being written — looked at
 *  only on a first prompt with a project. An unreadable mark costs the
 *  deferral, never the retrieval. */
const readSummaryPending = async (
  input: RetrievePromptInput,
  deps: RetrievePromptDeps,
  projectId: string | null,
  logSessionId: string,
) => {
  if (input.sessionStart !== true || projectId === null) return false;
  const [err, pending] = await attempt(async () =>
    deps.isSummaryPending(projectId, Date.now()),
  );
  if (err) {
    input.log.warn("summary-pending mark unreadable — treated as not pending", {
      sessionId: logSessionId,
      projectId,
      error: err.message,
    });
  }
  return pending === true;
};

/**
 * Runs the retrieve sequence for one prompt. `unavailable` when the
 * replica cannot be opened, `failed` when retrieval threw, otherwise
 * `retrieved` with the project it ran under.
 */
export const retrieveForPrompt = async (
  input: RetrievePromptInput,
  deps: RetrievePromptDeps = defaultDeps,
) => {
  const { log, sessionId } = input;
  const logSessionId = sessionId ?? UNNAMED_SESSION;

  const replicaPath =
    process.env.MIMIR_ORG_REPLICA_DB ?? defaultOrgReplicaPath();
  const [openErr, replica] = await attempt(async () =>
    deps.openReplica(replicaPath),
  );
  if (openErr) {
    log.warn("replica open failed — no injection", {
      replicaPath,
      error: openErr.message,
    });
    return { status: "unavailable" as const };
  }

  // Disk-cached after first resolution; the config/server is only
  // consulted on a cache miss.
  const projectId = await deps.activeProjectId(input.cwd);
  const exclude = await readSeen(input, deps, logSessionId);
  const summaryPending = await readSummaryPending(
    input,
    deps,
    projectId,
    logSessionId,
  );

  const [retrieveErr, result] = await attempt(async () =>
    deps.retrieveLocalContext(replica, input.prompt, {
      ...promptRetrieveOptions({
        projectId,
        exclude,
        projectNames: await deps.readProjectNames(),
        sessionStart: input.sessionStart === true,
        summaryPending,
      }),
      embedQuery: deps.createEmbedQuery(),
    }),
  );
  replica.close();
  if (retrieveErr) {
    log.warn("local retrieval failed", { error: errMessage(retrieveErr) });
    return { status: "failed" as const };
  }

  if (result.embedderUnavailable) {
    log.warn(
      "the embedder gave no query vector — memories and summaries not retrieved",
      { sessionId: logSessionId },
    );
  }
  if (result.summaryDeferred) {
    log.info("last session's summary still being written — slot deferred", {
      sessionId: logSessionId,
      projectId,
    });
  }

  const retrieved = { status: "retrieved" as const, projectId, result };
  if (result.contextBlock.length === 0) {
    log.debug("empty retrieval — no memories or summaries to inject");
    return retrieved;
  }

  const [recordErr] = await attempt(async () => {
    if (sessionId !== undefined) {
      await deps.recordInjectedIds(sessionId, result.injectedIds);
    }
  });
  if (recordErr) {
    log.warn("retrieve state not saved — these rows may be sent again", {
      sessionId: logSessionId,
      error: recordErr.message,
    });
  }

  log.info("retrieved context injected (local replica)", {
    sessionId: logSessionId,
    projectId,
    memoryCount: result.memoryCount,
    summaryCount: result.summaryCount,
    chars: result.contextBlock.length,
  });
  return retrieved;
};

/** The parts of a retrieval the hook's output is made from. */
type Retrieval = Pick<
  RetrievedContext,
  | "contextBlock"
  | "memoryCount"
  | "summaryCount"
  | "embedderUnavailable"
  | "summaryDeferred"
>;

/** The status line for a retrieval, or null when there is nothing to say. */
const retrieveStatus = (result: Retrieval) => {
  const base = result.embedderUnavailable
    ? EMBEDDER_UNAVAILABLE_STATUS
    : result.contextBlock.length > 0
      ? `↻ Retrieved ${result.memoryCount} memories / ${result.summaryCount} summaries (local)`
      : null;
  if (!result.summaryDeferred) return base;
  return base === null
    ? SUMMARY_PENDING_STATUS
    : `${base} · ${SUMMARY_PENDING_NOTE}`;
};

/**
 * What a UserPromptSubmit hook prints for one retrieval, or null to print
 * nothing. Pure. The block goes under the active project's
 * `<active_project>` prefix — re-injected every turn so the model can pass
 * the id to MCP tools after a compaction. A deferred summary is flagged
 * `summaryPending` whether or not there is anything to inject.
 */
export const promptContextOutput = (
  result: Retrieval,
  project: { readonly projectId: string | null },
) => {
  const status = retrieveStatus(result);
  if (status === null) return null;
  const projectPrefix = project.projectId
    ? `<active_project id="${project.projectId}" />\n`
    : "";
  return {
    ...(result.contextBlock.length > 0
      ? {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: `${projectPrefix}${result.contextBlock}`,
          },
        }
      : {}),
    systemMessage: status,
    ...(result.summaryDeferred ? { summaryPending: true } : {}),
  };
};
