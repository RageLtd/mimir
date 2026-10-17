/**
 * `mimir-cc precompact` — run by the hooks module on `session.compact`
 * with the main conversation's undistilled tail: belt-and-suspenders
 * distillation before the engine discards it (MIM-86: fully local,
 * nothing ships to the server).
 *
 * Fires when the engine is about to compact (/compact or auto-trigger).
 * Whatever the turn-end persist hasn't yet distilled gets two treatments
 * before the engine's history is summarized away:
 *   1. A type:"summary" replica memory (the narrative record boot-context
 *      reads by recency) — this run's primary purpose.
 *   2. Best-effort fact extraction, same as persist would have run.
 *
 * Answers `{ advance: true }` when the SUMMARY succeeds; extraction
 * failure only logs (retrying would re-store a near-identical summary,
 * which is worse than losing one window's facts). The module re-anchors
 * on the compacted conversation afterwards either way.
 *
 * Never blocks compaction — exit 0 unconditionally.
 */

import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import { extractFromConversation } from "@mimir/plugin-core/brain/extract";
import { summarizeToReplica } from "@mimir/plugin-core/brain/summarize";
import { getOrResolveProjectId } from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import {
  createOrgReplica,
  defaultOrgReplicaPath,
} from "@mimir/plugin-core/store/org-replica";
import { storeTyped } from "@mimir/plugin-core/tools/org-memory";
import { extractionConfig, readConfig } from "./config";
import { answer, readDistillInput, toModelMessages } from "./conversation";
import { createLogger } from "./logger";

const log = createLogger("precompact-hook");

/**
 * Entry point invoked from cli.ts when argv[2] === "precompact".
 * Exit 0 unconditionally — blocking compaction is the developer's call
 * via /compact, never ours.
 */
export const runPreCompactHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const input = await readDistillInput();
  const sessionId = input.session_id;
  const cwd = input.cwd ?? process.cwd();
  const trigger = input.trigger ?? "unknown";

  if (!sessionId) {
    log.debug("no session_id in payload — skipping", { trigger });
    return 0;
  }

  const messages = toModelMessages(input.messages ?? []);
  if (messages.length === 0) {
    answer(true);
    log.info("precompact: nothing new to distill (persist caught up)", {
      sessionId,
      trigger,
    });
    return 0;
  }

  const extraction = await extractionConfig();
  if (!extraction) {
    answer(true);
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
    answer(false);
    log.error("precompact: summarization failed", {
      sessionId,
      trigger,
      messages: messages.length,
      model: extraction.model,
    });
    return 0;
  }

  // Best-effort fact extraction over the same window — persist never saw
  // this tail, so its facts would otherwise be lost with the context.
  // Failure logs; the delta is settled regardless (see module doc for why).
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
  answer(true);

  log.info("precompact: window distilled locally", {
    sessionId,
    trigger,
    project: cwd,
    projectId,
    messagesInDelta: messages.length,
    summaryId: summary.id,
    summarySkipped: summary.skipped,
    factsStored: extracted,
    model: extraction.model,
  });

  return 0;
};
