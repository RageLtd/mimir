/**
 * Claude Code backend prompt path.
 *
 * Uses streaming-input mode: one CC subprocess per session, fed via
 * `streamInput`. The Query (held on `session.ccQuery` by the adapter) is
 * created on the first prompt and reused thereafter. Conversation continuity
 * is purely in-memory inside the live subprocess — no JSONL transcript on
 * disk, no `--continue` replay, no per-turn re-send of full history.
 *
 * mimir-acp tracks session state (`session.messages` for persistence,
 * `session.bootSequenceDone` for first-turn gating) but not cross-turn
 * working memory; that lives in the long-lived Query.
 *
 * The cross-turn channels:
 *   - First turn: assembleContext → full system prompt + boot content
 *     (user profile, project rules, session context) injected directly
 *     into the system prompt. XML-converted with model override. The
 *     system prompt is fixed at Query creation and cannot change.
 *   - Subsequent turns: getSystemPrompt (TTL-cached) → full system prompt
 *     for our records. The Query has already captured the first-turn
 *     prompt and ignores subsequent values; we still build it because
 *     mid-session model/mode changes go through the adapter via
 *     `setModel`/`setPermissionMode`, and the `xmlSystemPrompt` is
 *     harmless to re-pass.
 *
 * `session.bootSequenceDone` gates the first-turn assembly. Initialised to
 * `false` in newSession/restoreSession (core.ts) and reset on compact. Set
 * to `true` only after the first turn runs to completion — cancelled /
 * errored / refused first turns leave it `false` so the next prompt
 * re-attempts boot. The cost is one wasted assembleContext call per failed
 * first turn; the alternative (setting it eagerly) risks a session that
 * never receives boot context if the first turn errors.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { emitAgentText } from "../../agent/lifecycle-helpers";
import type { SessionState } from "../../agent/types";
import { isFileWriteTool } from "../../cartographer/lifecycle";
import {
  type AssembledMessage,
  assembleContext,
  type ContextClientConfig,
  getSystemPrompt,
  persistTurn,
  reportTokenUsage,
} from "../../context-client";
import { createRequestToolPermission } from "../../permissions";
import type { UserMemoryStore } from "../../store/user-memories";
import { buildUserContext } from "../../tools/user-memory";
import { errMessage } from "../../util";
import { createChildLogger, log } from "../../utils/log";
import { toAnthropicXml } from "../../utils/markdown-to-xml";
import type { Backend } from "../types";
import { type BootContent, formatBootContent } from "./boot-tools";
import { isValidCCMode } from "./config-options";
import { getContextWindow, setContextWindow } from "./context-window-cache";
import { type CcToolCallInfo, handleCCEvent } from "./event-handler";
import { formatContextForPrompt } from "./formatting";
import {
  advanceTurn,
  formatAnchor,
  nextAnchor,
  type VoiceAnchor,
} from "./voice-anchors";

export type VoiceAnchorOpts = {
  readonly library: readonly VoiceAnchor[];
  readonly interval: number;
};

const logger = createChildLogger(log, "prompt-cc");

/**
 * Prepend an anchor text chunk to promptBlocks when present, otherwise
 * return a clone with the anchor as a leading text block. Used so that
 * the SDK's acpBlocksToAnthropicContent path still sees the anchor.
 */
const blocksWithAnchor = (
  anchorText: string,
  blocks: readonly acp.ContentBlock[],
) => [
  { type: "text", text: `${anchorText}\n\n` } as acp.ContentBlock,
  ...blocks,
];

export type PromptViaClaudeCodeOptions = {
  readonly session: SessionState;
  readonly promptText: string;
  readonly conn: acp.AgentSideConnection;
  readonly abortController: AbortController;
  readonly backend: Backend;
  readonly contextClient: ContextClientConfig;
  readonly memoryStore: UserMemoryStore;
  readonly anchorOpts: VoiceAnchorOpts;
  readonly promptBlocks?: readonly acp.ContentBlock[];
};

export const promptViaClaudeCode = async (opts: PromptViaClaudeCodeOptions) => {
  const {
    session,
    promptText,
    conn,
    abortController,
    backend,
    contextClient,
    memoryStore,
    anchorOpts,
    promptBlocks,
  } = opts;

  // Track the user message for persistence before we read it in assembleContext.
  session.messages.push({ role: "user", content: promptText });
  const isFirstTurn = !session.bootSequenceDone;

  // Always fetch the full system prompt. On the first turn we need the
  // complete assembled context (messages, memories, summaries) to inject
  // as boot content. On subsequent turns the long-lived Query already has
  // the system prompt baked in at creation; we still build the XML form so
  // any observers downstream (logs, future tooling) see what would have
  // been sent. getSystemPrompt is TTL-cached so this is near-free.
  let xmlSystemPrompt: string;

  if (isFirstTurn) {
    const context = await assembleContext(
      contextClient,
      promptText,
      session.projectId ?? session.projectPath,
      abortController.signal,
    ).catch(errMessage);
    if (typeof context === "string") {
      logger.error("assembleContext failed:", context);
      await emitAgentText(
        conn,
        session.sessionId,
        `Context assembly failed: ${context}`,
      );
      return { stopReason: "refusal" as const, filesModified: false };
    }

    const contextMessages = context.messages as readonly AssembledMessage[];
    const priorMessages = contextMessages.slice(0, -1);
    const sessionContextText = formatContextForPrompt(priorMessages);

    const bootContent: BootContent = {
      userContext: buildUserContext(memoryStore),
      projectRules: session.projectRules,
      sessionContext: sessionContextText.length > 0 ? sessionContextText : null,
    };

    // Inject boot content directly into the system prompt — eliminates the
    // tool-call round trip that the old boot MCP server required.
    xmlSystemPrompt = `${toAnthropicXml(context.systemPrompt)}\n\n${formatBootContent(bootContent)}`;

    logger.info(
      {
        sessionContextChars: sessionContextText.length,
        sessionMessageCount: context.messages.length,
        systemPromptChars: xmlSystemPrompt.length,
      },
      "CC boot content injected into system prompt",
    );
  } else {
    try {
      const systemPrompt = await getSystemPrompt(
        contextClient,
        abortController.signal,
      );
      xmlSystemPrompt = toAnthropicXml(systemPrompt);
    } catch (err) {
      logger.warn(
        "system prompt fetch failed, using projectRules fallback:",
        err,
      );
      xmlSystemPrompt = toAnthropicXml(session.projectRules ?? "");
    }
  }

  // Voice anchor decision. Counter ticks once per ACP prompt (developer-
  // initiated), never per tool-result turn the SDK emits inside runClaudeCode.
  const effectiveInterval =
    anchorOpts.interval > 0 ? anchorOpts.interval : Number.POSITIVE_INFINITY;
  const step = nextAnchor(
    session.voiceAnchors,
    anchorOpts.library,
    effectiveInterval,
  );
  session.voiceAnchors = step.next;

  let sdkPrompt = promptText;
  let sdkBlocks = promptBlocks;
  if (step.inject) {
    const anchorText = formatAnchor(step.anchor);
    sdkPrompt = `${anchorText}\n\n${promptText}`;
    sdkBlocks =
      promptBlocks && promptBlocks.length > 0
        ? blocksWithAnchor(anchorText, promptBlocks)
        : promptBlocks;
    logger.info(
      {
        turn: step.next.turnCount,
        anchorIndex: step.next.anchorIndex,
        title: step.anchor.title,
      },
      "voice anchor injected",
    );
  }

  let assistantBuffer = "";
  let promptTokens: number | undefined;
  let totalCostUsd: number | undefined;

  // Per-invocation tool-call registry.
  const toolCallInfo: CcToolCallInfo = new Map();

  let cycles = 1;
  let inToolPhase = false;
  // Accumulates mid-turn `error` events (assistant message errors like
  // rate_limit / billing_error / max_output_tokens). Outcome is decided
  // at the `finish` boundary — matches prompt-server.ts and aligns with
  // the SDK's "one result message per turn" contract.
  let streamErrored: string | null = null;

  const requestToolPermission = createRequestToolPermission(
    conn,
    session.sessionId,
  );

  const iter = backend
    .run({
      prompt: sdkPrompt,
      promptBlocks: sdkBlocks,
      systemPrompt: xmlSystemPrompt,
      messages: session.messages,
      tools: [],
      projectPath: session.projectPath,
      clientMcpServers: session.clientMcpServers,
      metadata: {},
      modelId: session.currentModelId,
      permissionMode: isValidCCMode(session.currentMode)
        ? session.currentMode
        : undefined,
      effort: session.currentThoughtLevel,
      rules: session.rules,
      signal: abortController.signal,
      session,
      requestToolPermission,
    })
    [Symbol.asyncIterator]();

  while (true) {
    const step = await iter.next().catch(errMessage);
    if (typeof step === "string") {
      const filesModified = [...toolCallInfo.values()].some((t) =>
        isFileWriteTool(t.name),
      );
      if (abortController.signal.aborted) {
        return { stopReason: "cancelled" as const, filesModified };
      }
      logger.error("CC backend error:", step);
      await emitAgentText(conn, session.sessionId, `Error: ${step}`);
      return { stopReason: "refusal" as const, filesModified };
    }
    if (step.done) break;
    const event = step.value;

    if (event.type === "tool_result") {
      inToolPhase = true;
    } else if (
      (event.type === "text" || event.type === "thinking") &&
      inToolPhase
    ) {
      cycles++;
      inToolPhase = false;
    }

    await handleCCEvent({
      event,
      session,
      conn,
      toolCallInfo,
      onText: (delta) => {
        assistantBuffer += delta;
      },
    });

    if (event.type === "finish") {
      promptTokens = event.promptTokens;
      totalCostUsd = event.cost;
      if (typeof event.contextWindow === "number") {
        setContextWindow(session.currentModelId, event.contextWindow);
      }
      const size =
        event.contextWindow ?? getContextWindow(session.currentModelId) ?? 0;
      if (typeof promptTokens === "number" && promptTokens > 0 && size > 0) {
        await conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "usage_update",
            used: promptTokens,
            size,
            ...(typeof totalCostUsd === "number"
              ? { cost: { amount: totalCostUsd, currency: "USD" } }
              : {}),
          },
        });
      }

      // Outcome decision lives at the turn boundary. Cancellation trumps
      // everything — `query.interrupt()` produces a non-success result
      // and we want it to look like a clean cancellation, not a refusal.
      // Otherwise: non-success subtype → refusal with errors[] detail;
      // a mid-turn error that the SDK still flagged success at boundary
      // → still surface as refusal with the accumulated text.
      const filesModified = [...toolCallInfo.values()].some((t) =>
        isFileWriteTool(t.name),
      );
      if (abortController.signal.aborted) {
        return { stopReason: "cancelled" as const, filesModified };
      }
      if (event.stopReason && event.stopReason !== "success") {
        const detail =
          event.errors?.join("; ") ?? streamErrored ?? event.stopReason;
        await emitAgentText(conn, session.sessionId, `Error: ${detail}`);
        return { stopReason: "refusal" as const, filesModified };
      }
      if (streamErrored) {
        await emitAgentText(conn, session.sessionId, `Error: ${streamErrored}`);
        return { stopReason: "refusal" as const, filesModified };
      }
      // success — fall through; the next iter.next() returns done
    } else if (event.type === "error") {
      // Mid-turn error (assistant message error or iterator failure that
      // the SDK still followed up with a result). Mark and continue
      // draining; the boundary is the `finish` event, where outcome
      // is decided uniformly.
      streamErrored = event.error;
    }
  }

  if (assistantBuffer.length > 0) {
    session.messages.push({ role: "assistant", content: assistantBuffer });
  }

  // Commit extra cycle weight for iteration-weighted turn advancement.
  if (cycles > 1) {
    session.voiceAnchors = advanceTurn(session.voiceAnchors, cycles - 1);
    logger.debug(
      {
        cycles,
        turnCount: session.voiceAnchors.turnCount,
        lastAnchorTurn: session.voiceAnchors.lastAnchorTurn,
      },
      "iteration-weighted turn advancement",
    );
  }

  // Boot is complete only when a first turn ran end-to-end. Early returns
  // above (cancelled / refused / error) leave this `false` so the next
  // prompt re-attempts boot. Subsequent successful turns re-assign
  // harmlessly.
  session.bootSequenceDone = true;

  // Persist + token report.
  const projectForServer =
    session.projectId ?? session.projectPath ?? "default";
  persistTurn(contextClient, session.messages.slice(-2), projectForServer, {
    totalCostUsd,
  }).catch((err) => logger.warn("persistTurn failed:", err));

  if (typeof promptTokens === "number" && promptTokens > 0) {
    reportTokenUsage(
      contextClient,
      promptTokens,
      projectForServer,
      session.currentModelId,
    ).catch((err) => logger.warn("reportTokenUsage failed:", err));
  }

  const filesModified = [...toolCallInfo.values()].some((t) =>
    isFileWriteTool(t.name),
  );

  return { stopReason: "end_turn" as const, filesModified };
};
