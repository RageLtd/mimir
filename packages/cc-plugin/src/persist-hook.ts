/**
 * `mimir-cc persist` — run by the hooks module on `turn.complete` with the
 * main conversation's messages since the last distillation: extract
 * memories from them into the LOCAL replica (MIM-86). The server
 * persist/token-report legs are gone: the conversation never leaves the
 * machine. Converts the delta to conversation messages, runs extraction
 * on the user-chosen endpoint (extractionConfig), and stores the results
 * via the replica's embed→dedupe→store path.
 *
 * The module holds the watermark; this run answers `{ advance }`: true on
 * success OR deliberate skip (gates), false on extraction transport
 * failure so the next turn carries the same delta again. Unconfigured
 * extraction advances too — otherwise the delta grows unboundedly toward
 * an endpoint that will never exist.
 *
 * Exit code is always 0: a lost extraction cycle is far better than a
 * status line on every turn.
 */

import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import { extractFromConversation } from "@mimir/plugin-core/brain/extract";
import { getOrResolveProjectId } from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import {
  createOrgReplica,
  defaultOrgReplicaPath,
} from "@mimir/plugin-core/store/org-replica";
import { syncFromSharedConfig } from "@mimir/plugin-core/sync/cli";
import { storeTyped } from "@mimir/plugin-core/tools/org-memory";
import { extractionConfig, readConfig } from "./config";
import { answer, readDistillInput, toModelMessages } from "./conversation";
import { createLogger } from "./logger";

const log = createLogger("persist-hook");

/**
 * Entry point invoked from cli.ts when argv[2] === "persist".
 * Exit 0 on every path — see module doc.
 */
export const runPersistHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const input = await readDistillInput();
  const sessionId = input.session_id;
  const cwd = input.cwd ?? process.cwd();

  if (!sessionId) {
    log.debug("no session_id in payload — skipping");
    return 0;
  }

  const messages = toModelMessages(input.messages ?? []);
  if (messages.length === 0) {
    answer(true);
    log.debug("nothing to distil in the delta", { sessionId });
    return 0;
  }

  const extraction = await extractionConfig();
  if (!extraction) {
    // No endpoint will ever consume this delta — advance so it can't
    // accumulate forever. Loud once per turn in the log.
    answer(true);
    log.warn(
      "extraction unconfigured (MIMIR_EXTRACTION_BASE_URL / extractionBaseUrl) — turn not distilled",
      { sessionId, messages: messages.length },
    );
    return 0;
  }

  const outcome = await extractFromConversation(extraction, messages);
  if (!outcome.ok) {
    answer(false);
    log.error("extraction failed — the next turn carries this delta again", {
      sessionId,
      messages: messages.length,
      model: extraction.model,
    });
    return 0;
  }

  if (outcome.skipped) {
    answer(true);
    log.debug("extraction skipped", { sessionId, reason: outcome.skipped });
    return 0;
  }

  // Project id for memory attribution — disk-cached after first resolution.
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

  let stored = 0;
  let duplicates = 0;
  for (const memory of outcome.memories) {
    const [storeErr, result] = await attempt(() =>
      storeTyped(replica, embedQuery, {
        content: memory,
        type: "fact",
        ...(projectId ? { project: projectId } : {}),
      }),
    );
    if (storeErr) {
      log.warn("memory store failed", { error: storeErr.message });
      continue;
    }
    if (result.stored) stored++;
    else duplicates++;
  }
  replica.close();

  answer(true);

  log.info("turn distilled locally", {
    sessionId,
    project: cwd,
    projectId,
    messagesInDelta: messages.length,
    extracted: outcome.memories.length,
    stored,
    duplicates,
    model: extraction.model,
  });

  // Push leg (MIM-88): ship freshly distilled memories through the blind
  // sync relay. Bounded — the hook process exits after this; a missed
  // deadline just leaves them dirty for the next boot/persist sync.
  if (stored > 0) {
    const SYNC_DEADLINE_MS = 10_000;
    const [syncErr, synced] = await attempt(() =>
      Promise.race([
        syncFromSharedConfig(),
        new Promise<{ status: "deadline" }>((resolve) =>
          setTimeout(() => resolve({ status: "deadline" }), SYNC_DEADLINE_MS),
        ),
      ]),
    );
    if (syncErr) {
      log.warn("post-distill sync failed", { error: syncErr.message });
    } else {
      log.info("post-distill sync", { ...synced });
    }
  }

  return 0;
};
