/**
 * Per-turn retrieval injection — UserPromptSubmit hook.
 *
 * Fires on every developer prompt EXCEPT the first one (boot-context
 * handles the first prompt, owned by voice-anchor.ts). Calls
 * mimir-server's /v1/context/retrieve, receives a flattened
 * `<retrieved_context>` block plus memory/summary counts, then emits:
 *
 *   - hookSpecificOutput.additionalContext — the block, hidden from the
 *     developer's transcript view but visible to the model.
 *   - systemMessage — a tiny "↻ Retrieved N memories / M summaries"
 *     indicator displayed to the developer (NOT seen by the model).
 *
 * State: `~/.mimir/retrieve-state/<session-id>.json` — created on the
 * first hook call as a marker. Subsequent calls in the same session see
 * the marker exists and proceed with retrieval. Format is forward-
 * compatible (just records `initialized` timestamp today).
 *
 * Defence-in-depth: MIMIR_ACTIVE gate matches voice-anchor / rules /
 * reindex hooks so nested `claude` subprocesses can't accidentally fire.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getOrResolveProjectId } from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import { errMessage, mimirHome } from "@mimir/plugin-core/util";
import { authHeaders, readConfig } from "./config";
import { createLogger } from "./logger";

const log = createLogger("retrieve-hook");

const RETRIEVE_ROUTE = "/v1/context/retrieve";

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly prompt?: string;
  readonly cwd?: string;
};

type RetrieveResponse = {
  readonly contextBlock?: string;
  readonly memoryCount?: number;
  readonly summaryCount?: number;
};

const markerPath = (sessionId: string) =>
  join(mimirHome(), "retrieve-state", `${sessionId}.json`);

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

const ensureMarker = async (sessionId: string) => {
  const path = markerPath(sessionId);
  const file = Bun.file(path);
  if (await file.exists()) return true;
  await mkdir(dirname(path), { recursive: true }).catch(() => undefined);
  await Bun.write(path, JSON.stringify({ initialized: Date.now() }));
  return false;
};

const fetchRetrieval = async (
  serverUrl: string,
  query: string,
  project: string,
  projectId: string | null,
) => {
  const url = `${serverUrl}${RETRIEVE_ROUTE}`;
  const auth = await authHeaders();
  const [fetchErr, response] = await attempt(() =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...auth },
      body: JSON.stringify({
        query,
        project,
        ...(projectId ? { projectId } : {}),
      }),
    }),
  );
  if (fetchErr) {
    log.warn("retrieve fetch failed", { url, error: fetchErr.message });
    return null;
  }
  if (!response.ok) {
    log.warn("retrieve non-OK", { url, status: response.status });
    return null;
  }
  const [parseErr, payload] = await attempt(
    () => response.json() as Promise<RetrieveResponse>,
  );
  if (parseErr) {
    log.warn("retrieve JSON parse failed", { error: parseErr.message });
    return null;
  }
  return payload;
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
      systemMessage: `↻ Retrieved ${memoryCount} memories / ${summaryCount} summaries`,
    }),
  );
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

  const seenBefore = await ensureMarker(sessionId);
  if (!seenBefore) {
    log.debug("first prompt of session — boot-context owns this turn");
    return 0;
  }

  const config = await readConfig();
  if (!config) {
    log.debug("no config — skipping retrieve");
    return 0;
  }

  const projectId = await getOrResolveProjectId(
    config.serverUrl,
    cwd,
    config.apiKey,
  ).catch(() => null);

  const payload = await fetchRetrieval(
    config.serverUrl,
    prompt,
    cwd,
    projectId,
  ).catch((err) => {
    log.warn("fetchRetrieval threw", { error: errMessage(err) });
    return null;
  });

  if (!payload?.contextBlock || payload.contextBlock.length === 0) {
    log.debug("empty retrieval — no memories or summaries to inject");
    return 0;
  }

  // Prepend the project UUID so the model can pass it to MCP tools.
  // Re-injected every turn so it survives compaction.
  const projectPrefix = projectId
    ? `<active_project id="${projectId}" />\n`
    : "";
  const contextBlock = `${projectPrefix}${payload.contextBlock}`;

  const memoryCount = payload.memoryCount ?? 0;
  const summaryCount = payload.summaryCount ?? 0;

  emitInjection(contextBlock, memoryCount, summaryCount);

  log.info("retrieved context injected", {
    sessionId,
    projectId,
    memoryCount,
    summaryCount,
    chars: payload.contextBlock.length,
  });

  return 0;
};
