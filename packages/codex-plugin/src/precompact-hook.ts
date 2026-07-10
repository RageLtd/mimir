/**
 * PreCompact hook — belt-and-suspenders distillation before Codex
 * discards history (MIM-86 pattern, ported from cc-plugin).
 *
 * Fires when Codex is about to compact (/compact or auto-trigger).
 * Whatever rollout delta the Stop hook hasn't yet distilled gets two
 * treatments before the local history is summarized away:
 *   1. A type:"summary" replica memory (the narrative record boot-context
 *      reads by recency) — this is the hook's primary purpose.
 *   2. Best-effort fact extraction, same as the Stop hook would have run.
 *
 * Watermark advances when the SUMMARY succeeds; extraction failure only
 * logs (retrying would re-store a near-identical summary, which is worse
 * than losing one window's facts).
 *
 * Never blocks compaction — exit 0 unconditionally.
 */

import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import { extractFromConversation } from "@mimir/plugin-core/brain/extract";
import { summarizeToReplica } from "@mimir/plugin-core/brain/summarize";
import { getOrResolveProjectId } from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import { extractionConfig, readConfig } from "@mimir/plugin-core/shared-config";
import {
  createOrgReplica,
  defaultOrgReplicaPath,
} from "@mimir/plugin-core/store/org-replica";
import { storeTyped } from "@mimir/plugin-core/tools/org-memory";
import { readHookInput } from "./hook-input";
import { createLogger } from "./logger";
import { readDelta, readWatermark, writeWatermark } from "./rollout-delta";

const log = createLogger("precompact-hook");

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly transcript_path?: string;
  readonly cwd?: string;
  readonly trigger?: "manual" | "auto";
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

  if (!sessionId || !transcriptPath) {
    log.debug("missing session_id or transcript_path — skipping", { trigger });
    return 0;
  }

  const watermark = await readWatermark(sessionId);
  const { messages, newOffset } = await readDelta(transcriptPath, watermark);

  if (messages.length === 0) {
    if (newOffset > watermark) await writeWatermark(sessionId, newOffset);
    log.info("precompact: nothing new to distill (Stop hook caught up)", {
      sessionId,
      trigger,
      watermark,
      newOffset,
    });
    return 0;
  }

  const extraction = await extractionConfig();
  if (!extraction) {
    await writeWatermark(sessionId, newOffset);
    log.warn("extraction unconfigured — precompact window not distilled", {
      sessionId,
      trigger,
      messages: messages.length,
    });
    return 0;
  }

  const config = await readConfig();
  const projectId = config
    ? await getOrResolveProjectId(config.serverUrl, cwd, config.apiKey).catch(
        () => null,
      )
    : null;

  const replica = createOrgReplica(
    process.env.MIMIR_ORG_REPLICA_DB ?? defaultOrgReplicaPath(),
  );
  const embedQuery = createEmbedQuery();

  const summary = await summarizeToReplica({
    config: extraction,
    replica,
    messages,
    embed: embedQuery,
    projectId,
  });

  if (!summary.ok) {
    replica.close();
    log.error("precompact: summarization failed — keeping watermark", {
      sessionId,
      trigger,
      messages: messages.length,
      model: extraction.model,
    });
    return 0;
  }

  // Best-effort fact extraction over the same window — the Stop hook
  // never saw this tail, so its facts would otherwise be lost with the
  // rollout window. Failure logs; the watermark advances regardless (see
  // module doc for why).
  let extracted = 0;
  const outcome = await extractFromConversation(extraction, messages);
  if (outcome.ok && !outcome.skipped) {
    for (const memory of outcome.memories) {
      const [storeErr, result] = await attempt(() =>
        storeTyped(replica, embedQuery, {
          content: memory,
          type: "fact",
          ...(projectId ? { project: projectId } : {}),
        }),
      );
      if (!storeErr && result.stored) extracted++;
    }
  } else if (!outcome.ok) {
    log.warn("precompact: fact extraction failed (summary still stored)", {
      sessionId,
      trigger,
    });
  }

  replica.close();
  await writeWatermark(sessionId, newOffset);

  log.info("precompact: window distilled locally", {
    sessionId,
    trigger,
    project: cwd,
    projectId,
    watermark,
    newOffset,
    messagesInDelta: messages.length,
    summaryId: summary.id,
    summarySkipped: summary.skipped,
    factsStored: extracted,
    model: extraction.model,
  });

  return 0;
};
