/**
 * PreCompact hook — belt-and-suspenders distillation before Codex
 * discards history (MIM-86 pattern, ported from cc-plugin).
 *
 * Fires when Codex is about to compact (/compact or auto-trigger). The
 * rollout is append-only and Codex leaves no readable summary of its own,
 * so the window being compacted away is the conversation since the last
 * `compacted` record. It gets two treatments:
 *   1. A type:"summary" replica memory of that window (the narrative
 *      record boot-context reads by recency) — the hook's primary purpose.
 *      The session's previous Mimir summary is carried at the head of the
 *      summariser's input, so the narrative survives across compactions.
 *      The summary state records the line of the last message covered, so
 *      an unchanged window is not summarised twice.
 *   2. Best-effort fact extraction from the delta the Stop hook has not
 *      yet distilled — the rest of the window's facts are already stored.
 *
 * Watermark advances when the summary succeeds (or none was planned);
 * extraction failure only logs (retrying would re-store a near-identical
 * summary, which is worse than losing one window's facts). A failed
 * summary moves nothing, but the next window starts after this
 * compaction's boundary, so this window is not summarised again; the
 * Stop hook still reads its delta's facts from the append-only rollout.
 * The decisions live in precompact-plan.ts and the flow in
 * precompact-runner.ts; this file wires the real deps.
 *
 * Never blocks compaction — exit 0 unconditionally.
 */

import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import { extractFromConversation } from "@mimir/plugin-core/brain/extract";
import { summarizeToReplica } from "@mimir/plugin-core/brain/summarize";
import { getOrResolveProjectId } from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import { clearInjectedIds } from "@mimir/plugin-core/retrieve-state";
import { extractionConfig, readConfig } from "@mimir/plugin-core/shared-config";
import {
  createOrgReplica,
  defaultOrgReplicaPath,
} from "@mimir/plugin-core/store/org-replica";
import { syncAfterDistill } from "@mimir/plugin-core/sync/after-distill";
import { storeTyped } from "@mimir/plugin-core/tools/org-memory";
import { readHookInput } from "./hook-input";
import { createLogger } from "./logger";
import { runPreCompact } from "./precompact-runner";
import {
  readDelta,
  readSummaryState,
  readWatermark,
  readWindow,
  writeState,
} from "./rollout-delta";

const log = createLogger("precompact-hook");

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly transcript_path?: string;
  readonly cwd?: string;
  readonly trigger?: "manual" | "auto";
};

const resolveProjectId = async (cwd: string) => {
  const config = await readConfig();
  if (!config) return null;
  return getOrResolveProjectId(config.serverUrl, cwd, config.apiKey).catch(
    () => null,
  );
};

/**
 * The replica, embedder and project id, opened on first use so a
 * caught-up compaction touches none of them; `close` is idempotent.
 */
const lazyStore = (cwd: string) => {
  let opened: {
    readonly replica: ReturnType<typeof createOrgReplica>;
    readonly embedQuery: ReturnType<typeof createEmbedQuery>;
    readonly projectId: string | null;
  } | null = null;
  const get = async () => {
    opened ??= {
      projectId: await resolveProjectId(cwd),
      replica: createOrgReplica(
        process.env.MIMIR_ORG_REPLICA_DB ?? defaultOrgReplicaPath(),
      ),
      embedQuery: createEmbedQuery(),
    };
    return opened;
  };
  const close = () => {
    opened?.replica.close();
    opened = null;
  };
  const projectId = () => opened?.projectId ?? null;
  return { get, close, projectId };
};

const storeFacts = async (
  store: Awaited<ReturnType<ReturnType<typeof lazyStore>["get"]>>,
  memories: readonly string[],
) => {
  let stored = 0;
  for (const memory of memories) {
    const [storeErr, result] = await attempt(() =>
      storeTyped(store.replica, store.embedQuery, {
        content: memory,
        type: "fact",
        ...(store.projectId ? { project: store.projectId } : {}),
      }),
    );
    if (storeErr) {
      log.warn("precompact: memory store failed", { error: storeErr.message });
      continue;
    }
    if (result.stored) stored++;
  }
  return stored;
};

/**
 * Entry point invoked from cli.ts when argv[2] === "precompact".
 * Exit 0 unconditionally — blocking compaction is the developer's call
 * via /compact, never ours.
 */
export const runPreCompactHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const input = await readHookInput<HookInput>();

  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;
  const cwd = input.cwd ?? process.cwd();
  const trigger = input.trigger ?? "unknown";

  // The window is about to be replaced, so the rows retrieval put in it
  // may be sent again. Needs only the session id, so it comes before the
  // transcript check.
  if (sessionId) {
    const [clearErr] = await attempt(() => clearInjectedIds(sessionId));
    if (clearErr) {
      log.warn(
        "retrieve state not cleared — rows stay skipped after compaction",
        { sessionId, error: clearErr.message },
      );
    }
  }

  if (!sessionId || !transcriptPath) {
    log.debug("missing session_id or transcript_path — skipping", { trigger });
    return 0;
  }

  const extraction = await extractionConfig();
  const store = lazyStore(cwd);

  await runPreCompact(
    { sessionId, transcriptPath, trigger },
    {
      readWindow,
      readDelta,
      readWatermark,
      readSummaryState,
      writeState,
      summaryText: async (id) =>
        (await store.get()).replica.getMemory(id)?.content ?? null,
      summarize: async (messages) => {
        if (!extraction) return { ok: false, id: null };
        const { replica, embedQuery, projectId } = await store.get();
        return summarizeToReplica({
          config: extraction,
          replica,
          messages,
          embed: embedQuery,
          projectId,
        });
      },
      extractFacts: async (messages) => {
        if (!extraction) return 0;
        const outcome = await extractFromConversation(extraction, messages, {
          closing: true,
        });
        if (!outcome.ok) {
          log.warn("precompact: fact extraction failed (summary unaffected)", {
            sessionId,
            trigger,
          });
          return 0;
        }
        if (outcome.skipped) return 0;
        return storeFacts(await store.get(), outcome.memories);
      },
      sync: () => syncAfterDistill(log),
      close: store.close,
      projectId: store.projectId,
      extraction,
      log,
    },
  );

  return 0;
};
