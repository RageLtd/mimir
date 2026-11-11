/**
 * Per-turn retrieval injection — `mimir-cc retrieve`, run by the hooks
 * module's `prompt.submit` hook with the UserPromptSubmit payload.
 *
 * Fires on every developer prompt, the first included (boot context is
 * profile and project only, injected on `prompt.context`). Reads the
 * LOCAL org replica (MIM-84) — no server round-trip — and emits:
 *
 *   - hookSpecificOutput.additionalContext — the `<retrieved_context>`
 *     block, hidden from the developer's transcript view but visible to
 *     the model.
 *   - systemMessage — a tiny "↻ Retrieved N memories / M summaries"
 *     indicator for the developer (NOT seen by the model), which the
 *     hooks module puts on the status line.
 *
 * Empty or missing replica → inject nothing (same contract as an empty
 * retrieval). Run scripts/import-replica.ts to seed it; MIM-86 makes it
 * self-sustaining. The lone remaining network touch is project-id
 * resolution, which is disk-cached after the first call per project.
 *
 * Defence-in-depth: MIMIR_ACTIVE gate matches the rules / reindex hooks
 * so nested `claude` subprocesses can't accidentally fire.
 */

import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import { retrieveLocalContext } from "@mimir/plugin-core/brain/retrieve";
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
};

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

const emitInjection = (block: string, status: string) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: block,
      },
      systemMessage: status,
    }),
  );
};

const emitStatus = (status: string) => {
  process.stdout.write(JSON.stringify({ systemMessage: status }));
};

/**
 * Entry point invoked from cli.ts when argv[2] === "retrieve".
 * Returns 0 unconditionally — emitting an error code from
 * UserPromptSubmit would surface as a hook failure to the developer
 * even though the user's prompt would still go through; failing
 * silently in the log file is the right trade-off.
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

  const [retrieveErr, result] = await attempt(async () =>
    retrieveLocalContext(replica, prompt, {
      projectId: projectId ?? undefined,
      embedQuery: createEmbedQuery(),
      exclude: seen ?? new Set<string>(),
      projectNames: await readProjectNames(),
    }),
  );
  replica.close();
  if (retrieveErr) {
    log.warn("local retrieval failed", { error: errMessage(retrieveErr) });
    return 0;
  }

  if (result.embedderUnavailable) {
    log.warn(
      "the embedder gave no query vector — memories and summaries not retrieved",
      { sessionId },
    );
  }

  if (result.contextBlock.length === 0) {
    if (result.embedderUnavailable) emitStatus(EMBEDDER_UNAVAILABLE_STATUS);
    log.debug("empty retrieval — no memories or summaries to inject");
    return 0;
  }

  // Prepend the project UUID so the model can pass it to MCP tools.
  // Re-injected every turn so it survives compaction.
  const projectPrefix = projectId
    ? `<active_project id="${projectId}" />\n`
    : "";
  const contextBlock = `${projectPrefix}${result.contextBlock}`;

  emitInjection(
    contextBlock,
    result.embedderUnavailable
      ? EMBEDDER_UNAVAILABLE_STATUS
      : `↻ Retrieved ${result.memoryCount} memories / ${result.summaryCount} summaries (local)`,
  );

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
