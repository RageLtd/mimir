/**
 * Per-turn retrieval injection — UserPromptSubmit hook (ported from
 * cc-plugin).
 *
 * Fires on every developer prompt EXCEPT the first one (boot-context
 * handles the first prompt, owned by voice-anchor.ts). Reads the LOCAL
 * org replica — no server round-trip — and emits:
 *
 *   - hookSpecificOutput.additionalContext — the `<retrieved_context>`
 *     block, hidden from the developer's transcript view but visible to
 *     the model (Codex's hook output schema matches CC's — verified in
 *     codex-rs/hooks/schema).
 *   - systemMessage — a tiny "↻ Retrieved N memories / M summaries"
 *     indicator displayed to the developer (NOT seen by the model).
 *
 * Empty or missing replica → inject nothing (same contract as an empty
 * retrieval).
 *
 * State: `~/.mimir/retrieve-state/<session-id>.json` — created on the
 * first hook call as a marker. Subsequent calls in the same session see
 * the marker exists and proceed with retrieval.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import { retrieveLocalContext } from "@mimir/plugin-core/brain/retrieve";
import { getOrResolveProjectId } from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import { readConfig } from "@mimir/plugin-core/shared-config";
import {
  createOrgReplica,
  defaultOrgReplicaPath,
} from "@mimir/plugin-core/store/org-replica";
import { errMessage, mimirHome } from "@mimir/plugin-core/util";
import { readHookInput } from "./hook-input";
import { createLogger } from "./logger";

const log = createLogger("retrieve-hook");

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly prompt?: string;
  readonly cwd?: string;
};

const markerPath = (sessionId: string) =>
  join(mimirHome(), "retrieve-state", `${sessionId}.json`);

const ensureMarker = async (sessionId: string) => {
  const path = markerPath(sessionId);
  const file = Bun.file(path);
  if (await file.exists()) return true;
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  await Bun.write(path, JSON.stringify({ initialized: Date.now() }));
  return false;
};

const emitInjection = (
  block: string,
  memoryCount: number,
  summaryCount: number,
) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: block,
      },
      systemMessage: `↻ Retrieved ${memoryCount} memories / ${summaryCount} summaries (local)`,
    }),
  );
};

/**
 * Entry point invoked from cli.ts when argv[2] === "retrieve".
 * Returns 0 unconditionally — a hook failure would surface to the
 * developer even though their prompt still goes through; failing
 * silently in the log file is the right trade-off.
 */
export const runRetrieveHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const input = await readHookInput<HookInput>();
  const sessionId = input.session_id ?? "default";
  const prompt = input.prompt?.trim() ?? "";
  const cwd = input.cwd ?? process.cwd();

  if (prompt.length === 0) {
    log.debug("empty prompt, skipping");
    return 0;
  }

  const seenBefore = await ensureMarker(sessionId);
  if (!seenBefore) {
    log.debug("first prompt of session — boot-context owns this turn");
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

  // Project id for the scoring tiebreaker + playbook scope + the
  // <active_project> prefix. Disk-cached after first resolution; the
  // config/server is only consulted on a cache miss.
  const config = await readConfig();
  const projectId = config
    ? await getOrResolveProjectId(config.serverUrl, cwd, config.apiKey).catch(
        () => null,
      )
    : null;

  const [retrieveErr, result] = await attempt(() =>
    retrieveLocalContext(replica, prompt, {
      projectId: projectId ?? undefined,
      // MIM-85: local llama-server vector leg; null/cold → FTS-only turn.
      embedQuery: createEmbedQuery(),
    }),
  );
  replica.close();
  if (retrieveErr) {
    log.warn("local retrieval failed", { error: errMessage(retrieveErr) });
    return 0;
  }

  if (result.contextBlock.length === 0) {
    log.debug("empty retrieval — no memories or summaries to inject");
    return 0;
  }

  // Prepend the project UUID so the model can pass it to MCP tools.
  // Re-injected every turn so it survives compaction.
  const projectPrefix = projectId
    ? `<active_project id="${projectId}" />\n`
    : "";
  const contextBlock = `${projectPrefix}${result.contextBlock}`;

  emitInjection(contextBlock, result.memoryCount, result.summaryCount);

  log.info("retrieved context injected (local replica)", {
    sessionId,
    projectId,
    memoryCount: result.memoryCount,
    summaryCount: result.summaryCount,
    chars: result.contextBlock.length,
  });

  return 0;
};
