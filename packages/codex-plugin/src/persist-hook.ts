/**
 * Stop hook — extract memories from completed Codex turns into the LOCAL
 * replica (MIM-86 pattern, ported from cc-plugin). Reads new lines from
 * the session's rollout JSONL since the last watermark, renders them to
 * conversation messages, runs extraction on the user-chosen endpoint
 * (extractionConfig), and stores the results via the replica's
 * embed→dedupe→store path.
 *
 * Watermark semantics: advance on success; keep on extraction transport
 * failure so the next turn retries the same delta, and on a gate skip so
 * the next turn carries it (a turn alone rarely passes the two-user-turn
 * gate). Unconfigured extraction advances — otherwise the delta grows
 * unboundedly toward an endpoint that will never exist.
 *
 * Exit code is always 0. Returning non-zero from Stop would prevent
 * Codex from finishing the turn — far worse than a lost extraction cycle.
 */

import { extractFromConversation } from "@mimir/plugin-core/brain/extract";
import { openFactStore, storeFacts } from "@mimir/plugin-core/brain/fact-store";
import { activeProjectId } from "@mimir/plugin-core/project/active";
import { attempt } from "@mimir/plugin-core/result";
import { extractionConfig } from "@mimir/plugin-core/shared-config";
import { syncAfterDistill } from "@mimir/plugin-core/sync/after-distill";
import { readHookInput } from "./hook-input";
import { createLogger } from "./logger";
import { readDelta, readWatermark, writeWatermark } from "./rollout-delta";

const log = createLogger("persist-hook");

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly transcript_path?: string;
  readonly cwd?: string;
};

/**
 * Entry point invoked from cli.ts when argv[2] === "persist".
 * Exit 0 on every path — see module doc.
 */
export const runPersistHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const input = await readHookInput<HookInput>();

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

  const [persistErr] = await attempt(() =>
    persistTurn({ sessionId, transcriptPath, cwd }),
  );
  if (persistErr) {
    log.error("stop hook failed — turn not distilled", {
      sessionId,
      transcriptPath,
      error: persistErr.message,
    });
  }
  return 0;
};

/**
 * Distil the delta since the watermark. Rejects on a failed rollout read
 * or state write; runPersistHook logs it.
 */
const persistTurn = async ({
  sessionId,
  transcriptPath,
  cwd,
}: {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly cwd: string;
}) => {
  const watermark = await readWatermark(sessionId);
  const { messages, newOffset } = await readDelta(transcriptPath, watermark);

  if (messages.length === 0) {
    // Still advance the watermark if we read past empty/meta lines, so we
    // don't re-scan them next turn.
    if (newOffset > watermark) await writeWatermark(sessionId, newOffset);
    log.debug("no new messages in delta", { sessionId, watermark, newOffset });
    return;
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
    return;
  }

  const outcome = await extractFromConversation(extraction, messages);
  if (!outcome.ok) {
    log.error("extraction failed — leaving watermark in place for retry", {
      sessionId,
      messages: messages.length,
      model: extraction.model,
    });
    return;
  }

  if (outcome.skipped) {
    // Too little to distil yet. A turn is one user message, so advancing
    // here would drop every ordinary turn: the next turn carries it.
    log.debug("extraction skipped — the next turn carries this delta", {
      sessionId,
      reason: outcome.skipped,
    });
    return;
  }

  // Project id for memory attribution — disk-cached after first resolution.
  const projectId = await activeProjectId(cwd);

  const store = await openFactStore(projectId);
  const { stored, duplicates } = await storeFacts(store, outcome.memories, log);
  store.replica.close();

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

  if (stored > 0) await syncAfterDistill(log);
};
