/**
 * Claude Code backend prompt path.
 *
 * Fetches assembled context from mimir-server (system prompt, summaries,
 * memories, historical turns). Converts the system prompt to Anthropic XML,
 * injects local user context, formats prior turns as structured text in the
 * system prompt, and passes the current user message as the SDK prompt input.
 * mimir-server owns all context; CC is stateless.
 */

import type * as acp from "@agentclientprotocol/sdk";
import {
  buildToolCallContent,
  extractLocations,
  toolKindFor,
  toolTitle,
} from "../../agent/tool-reporting";
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
import type { Backend, BackendEvent } from "../types";
import { type BootContent, createBootServer } from "./boot-tools";
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

/** Maps tool call IDs to tool names + args so tool_result events can build rich content. */
const ccToolCallInfo = new Map<
  string,
  { name: string; input: Record<string, unknown> }
>();

/** Translate TodoWrite input into an ACP plan session update. */
const emitPlanUpdate = async (
  session: SessionState,
  conn: acp.AgentSideConnection,
  todos: readonly { content: string; status: string; activeForm?: string }[],
) => {
  await conn.sessionUpdate({
    sessionId: session.sessionId,
    update: {
      sessionUpdate: "plan",
      entries: todos.map((t) => ({
        content:
          t.activeForm && t.status === "in_progress" ? t.activeForm : t.content,
        status: t.status as "pending" | "in_progress" | "completed",
        priority: "medium" as const,
      })),
    },
  });
};

const handleCCEvent = async (
  event: BackendEvent,
  session: SessionState,
  conn: acp.AgentSideConnection,
  onText: (delta: string) => void,
): Promise<void> => {
  if (event.type === "text") {
    onText(event.text);
    await conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: event.text },
      },
    });
    return;
  }

  if (event.type === "thinking") {
    await conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: event.text },
      },
    });
    return;
  }

  if (event.type === "tool_call") {
    ccToolCallInfo.set(event.id, {
      name: event.name,
      input: event.input,
    });

    // TodoWrite → emit an ACP plan update alongside the normal tool card.
    if (event.name === "TodoWrite" && Array.isArray(event.input.todos)) {
      await emitPlanUpdate(
        session,
        conn,
        event.input.todos as {
          content: string;
          status: string;
          activeForm?: string;
        }[],
      );
    }

    const kind = toolKindFor(event.name);
    const locations = extractLocations(event.name, event.input);
    const title = toolTitle(event.name, event.input);
    const isBash =
      event.name === "Bash" ||
      event.name === "create_terminal" ||
      event.name === "terminal";

    await conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        _meta: {
          claudeCode: { toolName: event.name },
          ...(isBash && session.supportsTerminalOutput
            ? { terminal_info: { terminal_id: event.id } }
            : {}),
        },
        sessionUpdate: "tool_call",
        toolCallId: event.id,
        title,
        rawInput: event.input,
        kind,
        status: "pending" as const,
        content:
          isBash && session.supportsTerminalOutput
            ? [{ type: "terminal" as const, terminalId: event.id }]
            : [],
        ...(locations ? { locations } : {}),
      },
    });
    return;
  }

  if (event.type === "tool_result") {
    const info = ccToolCallInfo.get(event.id);
    const toolName = info?.name ?? event.id;

    const updateTitle = info ? toolTitle(info.name, info.input) : toolName;
    const isBash =
      toolName === "Bash" ||
      toolName === "create_terminal" ||
      toolName === "terminal";

    if (isBash && session.supportsTerminalOutput) {
      await conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          _meta: {
            terminal_output: { terminal_id: event.id, data: event.output },
          },
          sessionUpdate: "tool_call_update",
          toolCallId: event.id,
        },
      });
      await conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          _meta: {
            claudeCode: { toolName },
            terminal_exit: {
              terminal_id: event.id,
              exit_code: 0,
              signal: null,
            },
          },
          sessionUpdate: "tool_call_update",
          toolCallId: event.id,
          title: updateTitle,
          rawOutput: event.output,
          status: "completed" as const,
          content: [{ type: "terminal" as const, terminalId: event.id }],
        },
      });
    } else {
      const content = info
        ? buildToolCallContent(toolName, info.input, event.output)
        : undefined;
      await conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          _meta: { claudeCode: { toolName } },
          sessionUpdate: "tool_call_update",
          toolCallId: event.id,
          title: updateTitle,
          rawOutput: event.output,
          status: "completed" as const,
          ...(content ? { content } : {}),
        },
      });
    }
    return;
  }

  if (event.type === "error") {
    logger.error("CC error:", event.error);
    await conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `Error: ${event.error}` },
      },
    });
  }
};

/**
 * Strip the trailing user message from the assembled array when it
 * matches the current query — that message goes as the SDK prompt input,
 * not as context. Everything else (summaries, memories, prior turns)
 * becomes structured context in the system prompt.
 */
export const contextWithoutCurrentTurn = (
  messages: readonly AssembledMessage[],
  currentQuery: string,
) => {
  const last = messages[messages.length - 1];
  if (last?.role === "user" && last.content === currentQuery) {
    return messages.slice(0, -1);
  }
  return messages;
};

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

export const promptViaClaudeCode = async (
  session: SessionState,
  promptText: string,
  conn: acp.AgentSideConnection,
  abortController: AbortController,
  backend: Backend,
  contextClient: ContextClientConfig,
  memoryStore: UserMemoryStore,
  anchorOpts: VoiceAnchorOpts,
  promptBlocks?: readonly acp.ContentBlock[],
) => {
  // Single call to mimir-server assembles the full context: system prompt,
  // Goldfish memories, summaries, historical turns from DB, and the current
  // user message as the final entry.
  let context: Awaited<ReturnType<typeof assembleContext>>;
  try {
    context = await assembleContext(
      contextClient,
      promptText,
      session.projectId ?? session.projectPath,
      abortController.signal,
    );
  } catch (err) {
    const msg = errMessage(err);
    logger.error("assembleContext failed:", msg);
    await conn.sessionUpdate({
      sessionId: session.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `Context assembly failed: ${msg}` },
      },
    });
    return { stopReason: "end_turn" as const };
  }

  // Convert system prompt from markdown to Anthropic XML.
  const xmlSystemPrompt = toAnthropicXml(context.systemPrompt);

  // The server's assembled messages include the context injection pair
  // (summaries + memories), historical turns, and the current user message.
  // Strip the current user message — it goes as the SDK prompt input.
  // Everything else becomes session context for the boot tool.
  const contextMessages = contextWithoutCurrentTurn(
    context.messages,
    promptText,
  );

  // Session context (summaries, memories, prior turns from mimir-server)
  // is injected into the system prompt instead of a boot tool result.
  // This avoids the bloated tool result that replayed every turn.
  const sessionContextBlock = formatContextForPrompt(contextMessages);
  const systemPromptWithContext = sessionContextBlock
    ? `${xmlSystemPrompt}\n\n${sessionContextBlock}`
    : xmlSystemPrompt;

  // Build boot content and create the in-process MCP server. Content is
  // frozen at this point — each boot tool returns the same snapshot for
  // the lifetime of the query.
  const bootContent: BootContent = {
    userContext: buildUserContext(memoryStore),
    projectRules: session.projectRules,
  };
  const bootServer = createBootServer(bootContent);

  logger.info(
    {
      serverMessageCount: context.messages.length,
      contextMessageCount: contextMessages.length,
      sessionMessageCount: session.messages.length,
      roles: contextMessages.map((m) => m.role),
    },
    "context assembled for CC backend",
  );

  // Track the user message for persistence. The raw promptText is stored —
  // the anchor wrapping below only applies to what's sent to the model, not
  // to the transcript we persist.
  session.messages.push({ role: "user", content: promptText });

  // Voice anchor decision. Counter ticks once per ACP prompt (developer-
  // initiated), never per tool-result turn the SDK emits inside runClaudeCode.
  // An empty library or interval ≤ 0 makes nextAnchor a no-op.
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

  // Iteration-weighted turn counting for voice anchors. Each transition
  // from tool_result → text/thinking marks a new generation cycle; parallel
  // tool calls within a single generation don't inflate the count. Base
  // weight of 1 was already committed by nextAnchor above; we commit the
  // remainder (cycles - 1) after the loop.
  let cycles = 1;
  let inToolPhase = false;

  try {
    for await (const event of backend.run({
      prompt: sdkPrompt,
      promptBlocks: sdkBlocks,
      systemPrompt: systemPromptWithContext,
      messages: session.messages,
      tools: [],
      projectPath: session.projectPath,
      clientMcpServers: session.clientMcpServers,
      bootServer,
      metadata: {},
      modelId: session.currentModelId,
      // Session-level mode/thought-level selections flow through to the SDK
      // on each turn. Type assertion on currentMode narrows the persisted
      // string to the SDK's PermissionMode union — validation happened at
      // the agent/index.ts setSessionConfigOption boundary.
      permissionMode:
        session.currentMode as import("@anthropic-ai/claude-agent-sdk").PermissionMode,
      effort: session.currentThoughtLevel,
      ruleDetectors: session.ruleDetectors,
      signal: abortController.signal,
    })) {
      if (event.type === "tool_result") {
        inToolPhase = true;
      } else if (
        (event.type === "text" || event.type === "thinking") &&
        inToolPhase
      ) {
        cycles++;
        inToolPhase = false;
      }

      await handleCCEvent(event, session, conn, (delta) => {
        assistantBuffer += delta;
      });

      if (event.type === "finish") {
        promptTokens = event.promptTokens;
        totalCostUsd = event.cost;
        if (typeof promptTokens === "number" && promptTokens > 0) {
          await conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "usage_update",
              used: promptTokens,
              size: 200_000,
              ...(typeof totalCostUsd === "number"
                ? { cost: { amount: totalCostUsd, currency: "USD" } }
                : {}),
            },
          });
        }
      } else if (event.type === "error") {
        return { stopReason: "end_turn" as const };
      }
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      return { stopReason: "cancelled" as const };
    }
    const msg = errMessage(err);
    logger.error("CC backend error:", msg);
    return { stopReason: "end_turn" as const };
  }

  if (assistantBuffer.length > 0) {
    session.messages.push({ role: "assistant", content: assistantBuffer });
  }

  // Commit the extra cycle weight. A conversational turn (no tools) stays
  // at cycles=1 so this is a no-op; a tool-heavy turn advances the counter
  // by however many generation cycles the model actually produced, which
  // the next nextAnchor decision then reads.
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

  // Post-processing: persist + token report. Fire-and-forget.
  // Prefer the canonical project UUID; fall back to path until the resolver
  // completes (first-prompt race window) or when resolution failed entirely.
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
