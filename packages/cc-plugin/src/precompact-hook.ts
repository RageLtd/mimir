/**
 * `mimir-cc precompact` — run by the hooks module on `session.compact`
 * with the main conversation's undistilled tail (`messages`): distillation
 * before the engine discards it (MIM-86: fully local, nothing ships to the
 * server). A `window` in the payload, which an older plugin may still send,
 * is ignored.
 *
 * Fires when the engine is about to compact (/compact or auto-trigger).
 * The tail is appended to the session journal (session-journal.ts), then
 * the conversation gets two treatments:
 *   1. A type:"summary" replica memory of the session's uncovered journal,
 *      read after the append and led by the previous summary when one was
 *      carried — the narrative record of the conversation as it stood, and
 *      this run's primary purpose. An input over the summary cap is
 *      summarised from an opening slice plus the newest messages, the
 *      middle elided (brain/summarize.ts). A stored summary settles the
 *      journal through what it covered; nothing uncovered, or a journal
 *      that cannot be read, asks for no summary.
 *   2. Best-effort fact extraction over the tail alone, same as persist
 *      would have run — the rest persist already distilled.
 * Per-turn persist keeps the tail near-empty, so an empty tail with an
 * uncovered journal still runs; only when both are empty is there nothing
 * to do.
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
import {
  type ExtractionConfig,
  extractFromConversation,
  parseExtraction,
  prepareExtraction,
} from "@mimir/plugin-core/brain/extract";
import {
  type FactStore,
  openFactStore,
  storeFacts,
} from "@mimir/plugin-core/brain/fact-store";
import {
  prepareSummary,
  storeSummary,
  summarizeToReplica,
} from "@mimir/plugin-core/brain/summarize";
import { activeProjectId } from "@mimir/plugin-core/project/active";
import { syncAfterDistill } from "@mimir/plugin-core/sync/after-distill";
import { extractionConfig } from "./config";
import {
  answer,
  type Completions,
  completionText,
  isStalePayload,
  readDistillInput,
  SESSION_MODEL_EXTRACTION_CHARS,
  toModelMessages,
} from "./conversation";
import { createLogger } from "./logger";
import {
  journalMessages,
  readSummaryInput,
  settleJournal,
} from "./session-journal";

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
 * What this run does with the window. An empty delta and window is
 * already caught up; BYOK wins whenever configured; a module that cannot
 * run completions leaves it unconfigured; otherwise phase one settles
 * when both gates skip or requests what passed, and phase two stores what
 * came back — advancing unless the summary it asked for failed. The
 * summary gate reads the window — the runner passes the journal's summary
 * input — or the delta when there is none; the facts gate the delta alone.
 */
export const precompactPlan = (input: {
  readonly messages: readonly ModelMessage[];
  readonly window?: readonly ModelMessage[];
  readonly completions?: Completions;
  readonly extraction: ExtractionConfig | null;
  readonly hostCompletions: boolean;
}) => {
  const window = input.window ?? input.messages;
  if (input.messages.length === 0 && window.length === 0) {
    return { kind: "caught-up" as const };
  }
  if (input.extraction) return { kind: "byok" as const };
  if (!input.hostCompletions) return { kind: "unconfigured" as const };

  const summary = prepareSummary(window);
  const facts = prepareExtraction(input.messages, {
    maxChars: SESSION_MODEL_EXTRACTION_CHARS,
    closing: true,
  });
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
  readonly window: number;
  /** Where a stored summary settles the journal; null when it is unread. */
  readonly cursor: number | null;
};

/** A stored summary settles the journal through the read it was built from. */
const settleOnStore = (
  ctx: RunContext,
  summaryId: string | null,
  text: string | null,
) => {
  if (summaryId === null || text === null || ctx.cursor === null) return;
  settleJournal(ctx.sessionId, ctx.cursor, text);
};

/** The replica, embedder and project attribution every store path needs. */
const openStore = async (cwd: string) =>
  openFactStore(await activeProjectId(cwd));

/** Store extracted facts; returns how many were new. */
const storeNewFacts = async (store: FactStore, memories: readonly string[]) =>
  (await storeFacts(store, memories, log)).stored;

const runByok = async (
  extraction: ExtractionConfig,
  conversation: {
    readonly messages: readonly ModelMessage[];
    readonly window: readonly ModelMessage[];
  },
  ctx: RunContext,
) => {
  const store = await openStore(ctx.cwd);
  const { messages, window } = conversation;

  const summary = await summarizeToReplica({
    config: extraction,
    replica: store.replica,
    messages: window,
    embed: store.embedQuery,
    projectId: store.projectId,
  });
  settleOnStore(
    ctx,
    summary.id,
    "text" in summary ? (summary.text ?? null) : null,
  );

  if (!summary.ok) {
    store.replica.close();
    answer(false);
    log.error("precompact: summarization failed", {
      sessionId: ctx.sessionId,
      trigger: ctx.trigger,
      messagesInDelta: ctx.messages,
      messagesInWindow: ctx.window,
      model: extraction.model,
    });
    return;
  }

  // Best-effort fact extraction over the delta alone — persist never saw
  // this tail, so its facts would otherwise be lost with the context.
  // Failure logs; the delta is settled regardless (see module doc for why).
  let extracted = 0;
  const outcome = await extractFromConversation(extraction, messages, {
    closing: true,
  });
  if (outcome.ok && !outcome.skipped) {
    extracted = await storeNewFacts(store, outcome.memories);
  } else if (!outcome.ok) {
    log.warn("precompact: fact extraction failed (summary still stored)", {
      sessionId: ctx.sessionId,
      trigger: ctx.trigger,
      reason: outcome.reason,
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
    messagesInWindow: ctx.window,
    summaryId: summary.id,
    summarySkipped: summary.skipped,
    factsStored: extracted,
    model: extraction.model,
  });

  if (summary.id !== null || extracted > 0) await syncAfterDistill(log);
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
  settleOnStore(ctx, summaryId, plan.summary);
  const extracted = plan.memories
    ? await storeNewFacts(store, plan.memories)
    : 0;
  store.replica.close();
  answer(plan.advance);

  if (!plan.advance) {
    log.error("precompact: summarization failed", {
      sessionId: ctx.sessionId,
      trigger: ctx.trigger,
      messagesInDelta: ctx.messages,
      messagesInWindow: ctx.window,
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
    messagesInWindow: ctx.window,
    summaryId,
    // null: the facts gate skipped, or the completion failed or did not
    // parse — the plan settles either way (see module doc).
    factsExtracted: plan.memories?.length ?? null,
    factsStored: extracted,
    model: SESSION_MODEL,
    reasons: plan.reasons,
  });

  if (summaryId !== null || extracted > 0) await syncAfterDistill(log);
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

  if (isStalePayload(input)) {
    // Nothing printed: a classic PreCompact hook reads stdout as its own.
    log.warn(
      "payload carries no messages — the installed plugin is older than this binary; window not distilled",
      { sessionId, trigger },
    );
    return 0;
  }

  journalMessages(sessionId, input.messages ?? []);
  // The summary's input; an unreadable journal (logged there) gives none.
  const journal = readSummaryInput(sessionId);

  const messages = toModelMessages(input.messages ?? []);
  const window = journal?.messages ?? [];
  const extraction = await extractionConfig();
  const ctx = {
    sessionId,
    cwd,
    trigger,
    messages: messages.length,
    window: window.length,
    cursor: journal?.cursor ?? null,
  };
  const plan = precompactPlan({
    messages,
    window,
    extraction,
    hostCompletions: input.host_completions === true,
    ...(input.completions ? { completions: input.completions } : {}),
  });

  switch (plan.kind) {
    case "caught-up":
      answer(true);
      log.info("precompact: nothing to distill (empty window)", {
        sessionId,
        trigger,
      });
      return 0;
    case "byok":
      // precompactPlan answers byok only when extraction is configured.
      if (extraction) await runByok(extraction, { messages, window }, ctx);
      return 0;
    case "unconfigured":
      answer(true);
      log.warn("extraction unconfigured — precompact window not distilled", {
        sessionId,
        trigger,
        messagesInDelta: ctx.messages,
        messagesInWindow: ctx.window,
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
