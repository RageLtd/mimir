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
 * Where the completions run (MIM-134): BYOK in one run when an extraction
 * endpoint is configured; otherwise, when the module says it can run
 * completions (`host_completions`), two-phase — phase one answers
 * `{ advance: false, requests: { summary?, facts? } }` (each only when its
 * gate passed), the hooks module completes them on the session's model,
 * and phase two stores what came back. With neither, the window advances
 * undistilled, with a warning. `precompactPlan` is the pure
 * decision; the runner owns the side effects.
 *
 * Answers `{ advance: true }` when the SUMMARY succeeds (or was gated
 * out); extraction failure only logs (retrying would re-store a
 * near-identical summary, which is worse than losing one window's facts).
 * The module re-anchors on the compacted conversation afterwards either way.
 *
 * Never blocks compaction — exit 0 unconditionally.
 */

import type { ModelMessage } from "@ai-sdk/provider-utils";
import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import {
  type ExtractionConfig,
  extractFromConversation,
  parseExtraction,
  prepareExtraction,
} from "@mimir/plugin-core/brain/extract";
import {
  prepareSummary,
  storeSummary,
  summarizeToReplica,
} from "@mimir/plugin-core/brain/summarize";
import { getOrResolveProjectId } from "@mimir/plugin-core/project";
import { attempt } from "@mimir/plugin-core/result";
import {
  createOrgReplica,
  defaultOrgReplicaPath,
} from "@mimir/plugin-core/store/org-replica";
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

const log = createLogger("precompact-hook");

/** The request keys precompact asks the hooks module to complete. */
const SUMMARY = "summary";
const FACTS = "facts";
/** Log label for completions the hooks module ran on the session's model. */
const SESSION_MODEL = "session";

const assertNever = (value: never) => {
  throw new Error(`Unhandled precompact plan: ${JSON.stringify(value)}`);
};

/**
 * Phase two's summary: null when gated out (fine, no reason) or failed
 * (not fine, with the reason).
 */
const summaryOutcome = (gated: boolean, completions: Completions) => {
  if (gated) return { summary: null, ok: true, reason: null };
  const completion = completionText(completions, SUMMARY);
  if (!completion.ok) {
    return { summary: null, ok: false, reason: completion.reason };
  }
  // A blank summary is a failure, as completeChat's null-on-empty makes it
  // on the BYOK path — storeSummary would store nothing.
  if (!completion.text.trim()) {
    return {
      summary: null,
      ok: false,
      reason: `${SUMMARY} completion is blank`,
    };
  }
  return { summary: completion.text, ok: true, reason: null };
};

/** Phase two's facts: null when gated out (no reason), failed, or unparseable. */
const factsOutcome = (gated: boolean, completions: Completions) => {
  if (gated) return { memories: null, reason: null };
  const completion = completionText(completions, FACTS);
  if (!completion.ok) return { memories: null, reason: completion.reason };
  const memories = parseExtraction(completion.text);
  return memories === null
    ? {
        memories: null,
        reason: `${FACTS} completion is not a JSON string array`,
      }
    : { memories, reason: null };
};

/**
 * What this run does with the window. BYOK wins whenever configured; a
 * module that cannot run completions leaves it unconfigured; otherwise
 * phase one settles when both gates skip or requests what
 * passed, and phase two stores what came back — advancing unless the
 * summary it asked for failed.
 */
export const precompactPlan = (input: {
  readonly messages: readonly ModelMessage[];
  readonly completions?: Completions;
  readonly extraction: ExtractionConfig | null;
  readonly hostCompletions: boolean;
}) => {
  if (input.extraction) return { kind: "byok" as const };
  if (!input.hostCompletions) return { kind: "unconfigured" as const };

  const summary = prepareSummary(input.messages);
  const facts = prepareExtraction(input.messages);
  if ("skipped" in summary && "skipped" in facts) {
    return {
      kind: "settle" as const,
      advance: true as const,
      reason: `${SUMMARY}: ${summary.skipped}; ${FACTS}: ${facts.skipped}`,
    };
  }

  if (!input.completions) {
    return {
      kind: "request" as const,
      requests: {
        ...("request" in summary ? { [SUMMARY]: summary.request } : {}),
        ...("request" in facts ? { [FACTS]: facts.request } : {}),
      },
    };
  }

  const summarised = summaryOutcome("skipped" in summary, input.completions);
  const extracted = factsOutcome("skipped" in facts, input.completions);
  return {
    kind: "store" as const,
    summary: summarised.summary,
    memories: extracted.memories,
    advance: summarised.ok,
    reasons: [summarised.reason, extracted.reason].filter(
      (reason) => reason !== null,
    ),
  };
};

type RunContext = {
  readonly sessionId: string;
  readonly cwd: string;
  readonly trigger: string;
  readonly messages: number;
};

/** The replica, embedder and project attribution every store path needs. */
const openStore = async (cwd: string) => {
  const config = await readConfig();
  const projectId = config
    ? await getOrResolveProjectId(config.serverUrl, cwd, config.apiKey).catch(
        () => null,
      )
    : null;
  const replica = createOrgReplica(
    process.env.MIMIR_ORG_REPLICA_DB ?? defaultOrgReplicaPath(),
  );
  return { projectId, replica, embedQuery: createEmbedQuery() };
};

/** Store extracted facts; returns how many were new. */
const storeFacts = async (
  store: Awaited<ReturnType<typeof openStore>>,
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
      log.warn("memory store failed", { error: storeErr.message });
      continue;
    }
    if (result.stored) stored++;
  }
  return stored;
};

const runByok = async (
  extraction: ExtractionConfig,
  messages: readonly ModelMessage[],
  ctx: RunContext,
) => {
  const store = await openStore(ctx.cwd);

  const summary = await summarizeToReplica({
    config: extraction,
    replica: store.replica,
    messages,
    embed: store.embedQuery,
    projectId: store.projectId,
  });

  if (!summary.ok) {
    store.replica.close();
    answer(false);
    log.error("precompact: summarization failed", {
      sessionId: ctx.sessionId,
      trigger: ctx.trigger,
      messages: ctx.messages,
      model: extraction.model,
    });
    return;
  }

  // Best-effort fact extraction over the same window — persist never saw
  // this tail, so its facts would otherwise be lost with the context.
  // Failure logs; the delta is settled regardless (see module doc for why).
  let extracted = 0;
  const outcome = await extractFromConversation(extraction, messages);
  if (outcome.ok && !outcome.skipped) {
    extracted = await storeFacts(store, outcome.memories);
  } else if (!outcome.ok) {
    log.warn("precompact: fact extraction failed (summary still stored)", {
      sessionId: ctx.sessionId,
      trigger: ctx.trigger,
    });
  }

  store.replica.close();
  answer(true);

  log.info("precompact: window distilled locally", {
    sessionId: ctx.sessionId,
    trigger: ctx.trigger,
    project: ctx.cwd,
    projectId: store.projectId,
    messagesInDelta: ctx.messages,
    summaryId: summary.id,
    summarySkipped: summary.skipped,
    factsStored: extracted,
    model: extraction.model,
  });
};

const runStore = async (
  plan: {
    readonly summary: string | null;
    readonly memories: string[] | null;
    readonly advance: boolean;
    readonly reasons: readonly string[];
  },
  ctx: RunContext,
) => {
  const store = await openStore(ctx.cwd);
  const summaryId = plan.summary
    ? await storeSummary({
        replica: store.replica,
        embed: store.embedQuery,
        projectId: store.projectId,
        text: plan.summary,
      })
    : null;
  const extracted = plan.memories ? await storeFacts(store, plan.memories) : 0;
  store.replica.close();
  answer(plan.advance);

  if (!plan.advance) {
    log.error("precompact: summarization failed", {
      sessionId: ctx.sessionId,
      trigger: ctx.trigger,
      messages: ctx.messages,
      model: SESSION_MODEL,
      factsStored: extracted,
      reasons: plan.reasons,
    });
    return;
  }
  log.info("precompact: window distilled locally", {
    sessionId: ctx.sessionId,
    trigger: ctx.trigger,
    project: ctx.cwd,
    projectId: store.projectId,
    messagesInDelta: ctx.messages,
    summaryId,
    // null: the facts gate skipped, or the completion failed or did not
    // parse — the plan settles either way (see module doc).
    factsExtracted: plan.memories?.length ?? null,
    factsStored: extracted,
    model: SESSION_MODEL,
    reasons: plan.reasons,
  });
};

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
  const ctx = { sessionId, cwd, trigger, messages: messages.length };
  const plan = precompactPlan({
    messages,
    extraction,
    hostCompletions: input.host_completions === true,
    ...(input.completions ? { completions: input.completions } : {}),
  });

  switch (plan.kind) {
    case "byok":
      // precompactPlan answers byok only when extraction is configured.
      if (extraction) await runByok(extraction, messages, ctx);
      return 0;
    case "unconfigured":
      answer(true);
      log.warn("extraction unconfigured — precompact window not distilled", {
        sessionId,
        trigger,
        messages: ctx.messages,
      });
      return 0;
    case "settle":
      answer(plan.advance);
      log.info("precompact: window too small to distill", {
        sessionId,
        trigger,
        reason: plan.reason,
      });
      return 0;
    case "request":
      answer(false, plan.requests);
      log.debug("precompact: distillation handed to the session model", {
        sessionId,
        trigger,
        requests: Object.keys(plan.requests),
      });
      return 0;
    case "store":
      await runStore(plan, ctx);
      return 0;
    default:
      return assertNever(plan);
  }
};
