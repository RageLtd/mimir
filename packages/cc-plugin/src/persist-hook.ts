/**
 * `mimir-cc persist` — run by the hooks module on `turn.complete` with the
 * main conversation's messages since the last distillation: extract
 * memories from them into the LOCAL replica (MIM-86). The server
 * persist/token-report legs are gone: the conversation never leaves the
 * machine. Converts the delta to conversation messages, extracts, and
 * stores the results via the replica's embed→dedupe→store path.
 *
 * Where the completion runs (MIM-134):
 *   - extraction endpoint configured (extractionConfig) → one run, BYOK,
 *     as before.
 *   - not configured, and the module says it can run completions
 *     (`host_completions`) → two-phase. Phase one gates and renders, then
 *     answers `{ advance: false, requests: { facts } }`; the hooks module
 *     completes the request on the session's own model and runs persist
 *     again with `completions`, and phase two parses and stores.
 *   - neither → advance unread, with a warning: no endpoint will ever
 *     consume the delta, so it must not accumulate.
 * `persistPlan` is the pure decision; the runner owns the side effects.
 *
 * The module holds the watermark; this run answers `{ advance }`: true on
 * success OR deliberate skip (gates), false on extraction failure (BYOK
 * transport, or a phase-two completion that errored or did not parse) so
 * the next turn carries the same delta again.
 *
 * Exit code is always 0: a lost extraction cycle is far better than a
 * status line on every turn.
 */

import type { ModelMessage } from "@ai-sdk/provider-utils";
import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import {
  type ExtractionConfig,
  extractFromConversation,
  parseExtraction,
  prepareExtraction,
} from "@mimir/plugin-core/brain/extract";
import { getOrResolveProjectId } from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import {
  createOrgReplica,
  defaultOrgReplicaPath,
} from "@mimir/plugin-core/store/org-replica";
import { syncFromSharedConfig } from "@mimir/plugin-core/sync/cli";
import { storeTyped } from "@mimir/plugin-core/tools/org-memory";
import { extractionConfig, readConfig } from "./config";
import {
  answer,
  type Completions,
  completionText,
  readDistillInput,
  toModelMessages,
} from "./conversation";
import { createLogger } from "./logger";

const log = createLogger("persist-hook");

/** The request key persist asks the hooks module to complete. */
const FACTS = "facts";
/** Log label for completions the hooks module ran on the session's model. */
const SESSION_MODEL = "session";

const assertNever = (value: never) => {
  throw new Error(`Unhandled persist plan: ${JSON.stringify(value)}`);
};

/**
 * What this run does with the delta. BYOK wins whenever configured; a
 * module that cannot run completions leaves it unconfigured; otherwise
 * phase one (no completions) settles a gate skip or requests the facts
 * completion, and phase two stores what parsed or asks for a retry.
 */
export const persistPlan = (input: {
  readonly messages: readonly ModelMessage[];
  readonly completions?: Completions;
  readonly extraction: ExtractionConfig | null;
  readonly hostCompletions: boolean;
}) => {
  if (input.extraction) return { kind: "byok" as const };
  if (!input.hostCompletions) return { kind: "unconfigured" as const };

  const prepared = prepareExtraction(input.messages);
  if ("skipped" in prepared) {
    // Too little to distil yet. A turn is one user message, so settling
    // here would drop every ordinary turn: the next turn carries it.
    return {
      kind: "settle" as const,
      advance: false as const,
      reason: prepared.skipped,
    };
  }
  if (!input.completions) {
    return {
      kind: "request" as const,
      requests: { [FACTS]: prepared.request },
    };
  }

  const completion = completionText(input.completions, FACTS);
  if (!completion.ok) {
    return { kind: "retry" as const, reason: completion.reason };
  }
  const memories = parseExtraction(completion.text);
  if (memories === null) {
    return {
      kind: "retry" as const,
      reason: `${FACTS} completion is not a JSON string array`,
    };
  }
  return {
    kind: "store" as const,
    memories,
    replyChars: completion.text.length,
  };
};

type RunContext = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly messages: number;
};

/** Store extracted facts into the local replica, attributed to the project. */
const storeFacts = async (memories: readonly string[], cwd: string) => {
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
  for (const memory of memories) {
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
  return { projectId, stored, duplicates };
};

/**
 * Push leg (MIM-88): ship freshly distilled memories through the blind
 * sync relay. Bounded — the hook process exits after this; a missed
 * deadline just leaves them dirty for the next boot/persist sync.
 */
const syncAfterDistill = async () => {
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
};

/** Store, settle the delta, then sync anything new. */
const storeAndSettle = async (
  memories: readonly string[],
  ctx: RunContext,
  model: string,
) => {
  const { projectId, stored, duplicates } = await storeFacts(memories, ctx.cwd);

  answer(true);

  log.info("turn distilled locally", {
    sessionId: ctx.sessionId,
    project: ctx.cwd,
    projectId,
    messagesInDelta: ctx.messages,
    extracted: memories.length,
    stored,
    duplicates,
    model,
  });

  if (stored > 0) await syncAfterDistill();
};

const runByok = async (
  extraction: ExtractionConfig,
  messages: readonly ModelMessage[],
  ctx: RunContext,
) => {
  const outcome = await extractFromConversation(extraction, messages);
  if (!outcome.ok) {
    answer(false);
    log.error("extraction failed — the next turn carries this delta again", {
      sessionId: ctx.sessionId,
      messages: ctx.messages,
      model: extraction.model,
    });
    return;
  }

  if (outcome.skipped) {
    // Carried, like the session-model path: see persistPlan.
    answer(false);
    log.debug("extraction skipped — the next turn carries this delta", {
      sessionId: ctx.sessionId,
      reason: outcome.skipped,
    });
    return;
  }

  await storeAndSettle(outcome.memories, ctx, extraction.model);
};

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
  const ctx = { sessionId, cwd, messages: messages.length };
  const plan = persistPlan({
    messages,
    extraction,
    hostCompletions: input.host_completions === true,
    ...(input.completions ? { completions: input.completions } : {}),
  });

  switch (plan.kind) {
    case "byok":
      // persistPlan answers byok only when extraction is configured.
      if (extraction) await runByok(extraction, messages, ctx);
      return 0;
    case "unconfigured":
      // No endpoint and a module that cannot complete requests: nothing
      // will ever consume this delta — advance so it can't accumulate
      // forever. Loud once per turn in the log.
      answer(true);
      log.warn(
        "extraction unconfigured (MIMIR_EXTRACTION_BASE_URL / extractionBaseUrl) — turn not distilled",
        { sessionId, messages: ctx.messages },
      );
      return 0;
    case "settle":
      answer(plan.advance);
      log.debug("extraction skipped — the next turn carries this delta", {
        sessionId,
        messages: ctx.messages,
        reason: plan.reason,
      });
      return 0;
    case "request":
      answer(false, plan.requests);
      log.debug("extraction handed to the session model", {
        sessionId,
        messages: ctx.messages,
        promptChars: plan.requests[FACTS].prompt.length,
      });
      return 0;
    case "retry":
      answer(false);
      log.error("extraction failed — the next turn carries this delta again", {
        sessionId,
        messages: ctx.messages,
        model: SESSION_MODEL,
        reason: plan.reason,
      });
      return 0;
    case "store":
      log.debug("session model replied", {
        sessionId,
        replyChars: plan.replyChars,
        memories: plan.memories.length,
      });
      await storeAndSettle(plan.memories, ctx, SESSION_MODEL);
      return 0;
    default:
      return assertNever(plan);
  }
};
