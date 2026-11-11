/**
 * Per-turn retrieval injection — `mimir-cc retrieve`, run by the hooks
 * module's `prompt.submit` hook with the UserPromptSubmit payload.
 *
 * Fires on every developer prompt, the first included (boot context is
 * profile and project only, injected on `prompt.context`). On the first,
 * flagged `session_start`, retrieval also brings the active project's
 * newest summary, near the prompt or not. Reads the
 * LOCAL org replica (MIM-84) — no server round-trip — and emits:
 *
 *   - hookSpecificOutput.additionalContext — the `<retrieved_context>`
 *     block, hidden from the developer's transcript view but visible to
 *     the model.
 *   - systemMessage — a tiny "↻ Retrieved N memories / M summaries"
 *     indicator for the developer (NOT seen by the model), which the
 *     hooks module puts on the status line.
 *   - summaryPending — the summary is still owed: the hooks module sends
 *     the next prompt as `session_start` again, until an answer comes back
 *     without the flag. On a first prompt whose project's last summary is
 *     still being written (the summary-pending mark), it is set whatever
 *     the distance gate admitted: the newest-summary fallback stays out of
 *     the slot, while a summary near the prompt is still injected. A first
 *     prompt whose retrieval failed (replica unopenable, retrieval threw)
 *     prints the flag alone, so the summary stays owed without claiming
 *     it is still generating.
 *
 * Empty replica → inject nothing (same contract as an empty retrieval). Run scripts/import-replica.ts to seed it; MIM-86 makes it
 * self-sustaining. The lone remaining network touch is project-id
 * resolution, which is disk-cached after the first call per project.
 *
 * Defence-in-depth: MIMIR_ACTIVE gate matches the rules / reindex hooks
 * so nested `claude` subprocesses can't accidentally fire.
 */

import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import {
  type RetrievedContext,
  retrieveLocalContext,
} from "@mimir/plugin-core/brain/retrieve";
import {
  getOrResolveProjectId,
  readProjectNames,
} from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import {
  clearInjectedIds,
  readInjectedIds,
  recordInjectedIds,
} from "@mimir/plugin-core/retrieve-state";
import {
  createOrgReplica,
  defaultOrgReplicaPath,
} from "@mimir/plugin-core/store/org-replica";
import { isSummaryPending } from "@mimir/plugin-core/summary-pending";
import { errMessage } from "@mimir/plugin-core/util";
import { readConfig } from "./config";
import { createLogger } from "./logger";

const log = createLogger("retrieve-hook");

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly prompt?: string;
  readonly cwd?: string;
  /** True on the first prompt after a compaction replaced the window. */
  readonly window_reset?: boolean;
  /** True on the session's first prompt: the active project's newest
   *  summary is injected even when it is not near the prompt. */
  readonly session_start?: boolean;
};

/**
 * Retrieval's options for one prompt, from the hook payload and what the
 * hook resolved around it. Pure — the query embedder is added by the
 * caller. A first prompt flagged `session_start` asks for the active
 * project's newest summary — or, while that project's last summary is
 * still being written, defers it; a pending summary means nothing to a
 * later prompt. An unresolved project is no project.
 */
export const retrieveOptions = (
  input: HookInput,
  resolved: {
    readonly projectId: string | null;
    readonly exclude: ReadonlySet<string>;
    readonly projectNames: Readonly<Record<string, string>>;
    readonly summaryPending: boolean;
  },
) => ({
  projectId: resolved.projectId ?? undefined,
  exclude: resolved.exclude,
  projectNames: resolved.projectNames,
  sessionStart: input.session_start === true,
  summaryPending: input.session_start === true && resolved.summaryPending,
});

const readStdin = async () => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const safeParseHookInput = async (raw: string) => {
  if (raw.trim().length === 0) return {} as HookInput;
  const [err, parsed] = await attempt(async () => JSON.parse(raw) as HookInput);
  return err ? ({} as HookInput) : parsed;
};

const EMBEDDER_UNAVAILABLE_STATUS =
  "↻ Retrieval skipped: the embedder gave no vector";
const SUMMARY_PENDING_STATUS = "↻ Last session's summary is still generating";
const SUMMARY_PENDING_NOTE = "last session's summary is still generating";

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
 * What the hook prints for one retrieval, or null to print nothing. Pure.
 * The block goes under the active project's `<active_project>` prefix —
 * re-injected every turn so the model can pass the id to MCP tools after a
 * compaction. A deferred summary is flagged `summaryPending` whether or not
 * there is anything to inject.
 */
export const retrieveOutput = (
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

/**
 * What the hook prints when retrieval itself failed, or null to print
 * nothing. Pure. A first prompt keeps the summary owed — printing nothing
 * would read as settled — with no status line, since no one looked whether
 * it is still being written.
 */
export const retrieveFailureOutput = (input: HookInput) =>
  input.session_start === true ? { summaryPending: true } : null;

const printFailure = (input: HookInput) => {
  const output = retrieveFailureOutput(input);
  if (output !== null) process.stdout.write(JSON.stringify(output));
};

/**
 * Entry point invoked from cli.ts when argv[2] === "retrieve".
 * Returns 0 unconditionally — emitting an error code from
 * UserPromptSubmit would surface as a hook failure to the developer
 * even though the user's prompt would still go through; a failure is
 * logged, and on a first prompt answered with `retrieveFailureOutput`.
 */
export const runRetrieveHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const raw = await readStdin();
  const input = await safeParseHookInput(raw);
  const sessionId = input.session_id ?? "default";
  const prompt = input.prompt?.trim() ?? "";
  const cwd = input.cwd ?? process.cwd();

  if (prompt.length === 0) {
    log.debug("empty prompt, skipping");
    return 0;
  }

  const replicaPath =
    process.env.MIMIR_ORG_REPLICA_DB ?? defaultOrgReplicaPath();
  const [openErr, replica] = await attempt(async () =>
    createOrgReplica(replicaPath),
  );
  if (openErr) {
    log.warn("replica open failed — no injection", {
      replicaPath,
      error: openErr.message,
    });
    printFailure(input);
    return 0;
  }

  // Project id for the wider same-project gate + playbook scope + the
  // <active_project> prefix. Disk-cached after first resolution; the
  // config/server is only consulted on a cache miss.
  const config = await readConfig();
  const projectId = config
    ? await getOrResolveProjectId(config.serverUrl, cwd, config.apiKey).catch(
        () => null,
      )
    : null;

  // Rows already in this session's context window are not sent again.
  // Without a session id there is no window to track: nothing is skipped
  // and nothing recorded.
  const stateId = input.session_id;
  const [seenErr, seen] = await attempt(async () => {
    if (stateId === undefined) return new Set<string>();
    // A compaction replaced the window, so its rows may be sent again.
    // Done here, on the next prompt, because the precompact run is
    // detached and would race this read.
    if (input.window_reset === true) await clearInjectedIds(stateId);
    return readInjectedIds(stateId);
  });
  if (seenErr) {
    log.warn("retrieve state unreadable — nothing is skipped this prompt", {
      sessionId,
      error: seenErr.message,
    });
  }

  // The last session's summary still being written; `retrieveOptions`
  // passes it on only for a first prompt. An unreadable mark costs the
  // deferral, never the retrieval.
  const [pendingErr, summaryPending] = await attempt(async () =>
    projectId !== null ? isSummaryPending(projectId, Date.now()) : false,
  );
  if (pendingErr) {
    log.warn("summary-pending mark unreadable — treated as not pending", {
      sessionId,
      projectId,
      error: pendingErr.message,
    });
  }

  const [retrieveErr, result] = await attempt(async () =>
    retrieveLocalContext(replica, prompt, {
      ...retrieveOptions(input, {
        projectId,
        exclude: seen ?? new Set<string>(),
        projectNames: await readProjectNames(),
        summaryPending: summaryPending === true,
      }),
      embedQuery: createEmbedQuery(),
    }),
  );
  replica.close();
  if (retrieveErr) {
    log.warn("local retrieval failed", { error: errMessage(retrieveErr) });
    printFailure(input);
    return 0;
  }

  if (result.embedderUnavailable) {
    log.warn(
      "the embedder gave no query vector — memories and summaries not retrieved",
      { sessionId },
    );
  }

  if (result.summaryDeferred) {
    log.info("last session's summary still being written — slot deferred", {
      sessionId,
      projectId,
    });
  }

  const output = retrieveOutput(result, { projectId });
  if (output !== null) process.stdout.write(JSON.stringify(output));

  if (result.contextBlock.length === 0) {
    log.debug("empty retrieval — no memories or summaries to inject");
    return 0;
  }

  const [recordErr] = await attempt(async () => {
    if (stateId !== undefined) {
      await recordInjectedIds(stateId, result.injectedIds);
    }
  });
  if (recordErr) {
    log.warn("retrieve state not saved — these rows may be sent again", {
      sessionId,
      error: recordErr.message,
    });
  }

  log.info("retrieved context injected (local replica)", {
    sessionId,
    projectId,
    memoryCount: result.memoryCount,
    summaryCount: result.summaryCount,
    chars: result.contextBlock.length,
  });

  return 0;
};
