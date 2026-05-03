/**
 * Claude Code backend prompt path.
 *
 * Uses SDK `persistSession: true, continue: true` mode — the SDK carries
 * conversation context across turns. mimir-acp tracks session state
 * (`session.messages` for persistence, `session.bootSequenceDone` for
 * first-turn gating) but not cross-turn working memory.
 *
 * The cross-turn channels:
 *   - First turn only: assembleContext → system prompt + session context text
 *     → boot tools → SDK receives complete context snapshot + boot server.
 *   - Subsequent turns: SDK's `continue: true` maintains conversation
 *     continuity automatically; no assembleContext, no boot server creation.
 *   - `session.projectRules` is the immutable system prompt anchor.
 *
 * `session.bootSequenceDone` gates the first-turn assembly. Initialised to
 * `false` in newSession/restoreSession (core.ts). Set to `true` only after
 * the first turn runs to completion — cancelled / errored / refused first
 * turns leave it `false` so the next prompt re-attempts boot. The cost is
 * one wasted assembleContext call per failed first turn; the alternative
 * (setting it eagerly) risks a session that never receives boot context if
 * the first turn errors before the model invokes the boot tools.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { emitAgentText } from "../../agent/lifecycle-helpers";
import type { SessionState } from "../../agent/types";
import {
  type AssembledMessage,
  assembleContext,
  type ContextClientConfig,
  persistTurn,
  reportTokenUsage,
} from "../../context-client";
import type { UserMemoryStore } from "../../store/user-memories";
import { buildUserContext } from "../../tools/user-memory";
import { errMessage } from "../../util";
import { createChildLogger, log } from "../../utils/log";
import { toAnthropicXml } from "../../utils/markdown-to-xml";
import type { Backend } from "../types";
import { type BootContent, createBootServer } from "./boot-tools";
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

  let bootServer: ReturnType<typeof createBootServer> | undefined;
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
      return { stopReason: "refusal" as const };
    }

    xmlSystemPrompt = toAnthropicXml(context.systemPrompt);

    const contextMessages = context.messages as readonly AssembledMessage[];
    const priorMessages = contextMessages.slice(0, -1);
    const sessionContextText = formatContextForPrompt(priorMessages);

    const bootContent: BootContent = {
      userContext: buildUserContext(memoryStore),
      projectRules: session.projectRules,
      sessionContext: sessionContextText.length > 0 ? sessionContextText : null,
    };
    bootServer = createBootServer(bootContent);

    logger.info(
      {
        sessionContextChars: sessionContextText.length,
        sessionMessageCount: context.messages.length,
        systemPromptChars: xmlSystemPrompt.length,
      },
      "CC boot sequence assembled",
    );
  } else {
    // Subsequent turns: use projectRules as minimal system prompt.
    // SDK's continue:true handles conversation continuity.
    xmlSystemPrompt = toAnthropicXml(session.projectRules ?? "");
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

  const iter = backend
    .run({
      prompt: sdkPrompt,
      promptBlocks: sdkBlocks,
      systemPrompt: xmlSystemPrompt,
      messages: session.messages,
      tools: [],
      projectPath: session.projectPath,
      clientMcpServers: session.clientMcpServers,
      bootServer,
      metadata: {},
      modelId: session.currentModelId,
      permissionMode: isValidCCMode(session.currentMode)
        ? session.currentMode
        : undefined,
      effort: session.currentThoughtLevel,
      rules: session.rules,
      signal: abortController.signal,
    })
    [Symbol.asyncIterator]();

  while (true) {
    const step = await iter.next().catch(errMessage);
    if (typeof step === "string") {
      if (abortController.signal.aborted) {
        return { stopReason: "cancelled" as const };
      }
      logger.error("CC backend error:", step);
      await emitAgentText(conn, session.sessionId, `Error: ${step}`);
      return { stopReason: "refusal" as const };
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
    } else if (event.type === "error") {
      return { stopReason: "refusal" as const };
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

  return { stopReason: "end_turn" as const };
};
