/**
 * Stop hook — extract memories from completed CC turns into the LOCAL
 * replica (MIM-86). The server persist/token-report legs are gone: the
 * transcript never leaves the machine. Reads new lines from the session's
 * transcript JSONL since the last watermark, renders them to conversation
 * text, runs extraction on the user-chosen endpoint (extractionConfig),
 * and stores the results via the replica's embed→dedupe→store path.
 *
 * Watermark semantics: advance on success OR deliberate skip (gates),
 * keep on extraction transport failure so the next turn retries the same
 * delta. Unconfigured extraction advances too — otherwise the delta grows
 * unboundedly toward an endpoint that will never exist.
 *
 * Exit code is always 0. Returning non-zero from Stop would prevent CC
 * from finishing the turn — far worse than a lost extraction cycle.
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
import { createLogger } from "./logger";
import { readDelta, readWatermark, writeWatermark } from "./transcript-delta";

const log = createLogger("persist-hook");

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly transcript_path?: string;
  readonly cwd?: string;
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

/**
 * Entry point invoked from cli.ts when argv[2] === "persist".
 * Exit 0 on every path — see module doc.
 */
export const runPersistHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const raw = await readStdin();
  const input = await safeParseHookInput(raw);

  const sessionId = input.session_id;
  const transcriptPath = input.transcript_path;
  const cwd = input.cwd ?? process.cwd();

  if (!sessionId) {
    log.debug("no session_id in hook payload — skipping");
    return 0;
  }
  if (!transcriptPath) {
    log.debug("no transcript_path in hook payload — skipping");
    return 0;
  }

  const watermark = await readWatermark(sessionId);
  const { messages, newOffset } = await readDelta(transcriptPath, watermark);

  if (messages.length === 0) {
    // Still advance the watermark if we read past empty/meta lines, so we
    // don't re-scan them next turn.
    if (newOffset > watermark) await writeWatermark(sessionId, newOffset);
    log.debug("no new messages in delta", { sessionId, watermark, newOffset });
    return 0;
  }

  const extraction = await extractionConfig();
  if (!extraction) {
    // No endpoint will ever consume this delta — advance so it can't
    // accumulate forever. Loud once per turn in the log.
    await writeWatermark(sessionId, newOffset);
    log.warn(
      "extraction unconfigured (MIMIR_EXTRACTION_BASE_URL / extractionBaseUrl) — turn not distilled",
      { sessionId, messages: messages.length },
    );
    return 0;
  }

  const outcome = await extractFromConversation(extraction, messages);
  if (!outcome.ok) {
    log.error("extraction failed — leaving watermark in place for retry", {
      sessionId,
      messages: messages.length,
      model: extraction.model,
    });
    return 0;
  }

  if (outcome.skipped) {
    await writeWatermark(sessionId, newOffset);
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

  await writeWatermark(sessionId, newOffset);

  log.info("turn distilled locally", {
    sessionId,
    project: cwd,
    projectId,
    watermark,
    newOffset,
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
