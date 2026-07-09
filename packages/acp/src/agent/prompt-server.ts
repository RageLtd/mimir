/**
 * Local agent loop (MIM-89 inversion).
 *
 * Assembles the turn context locally (replica retrieval + user profile +
 * project rules as ONE synthetic injection pair), streams the model turn
 * through the local backend, executes tool calls (org-memory over the
 * replica, cartographer, user-memory, client-forwarded, client MCP,
 * TodoWrite as a plan update), and loops until the model finishes
 * without requesting tools.
 *
 * The conversation lives in `session.messages` — the injection pair is
 * rebuilt per prompt and NEVER persisted into it. No mimir-server calls
 * remain on this path; the only server round-trips are the boot-time
 * system prompt fetch and project resolution.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { retrieveLocalContext } from "@mimir/plugin-core/brain/retrieve";
import { runAndFormat } from "@mimir/plugin-core/rules";
import type { OrgReplica } from "@mimir/plugin-core/store/org-replica";
import type { UserMemoryStore } from "@mimir/plugin-core/store/user-memories";
import { cartToolDefs } from "@mimir/plugin-core/tools/cart-tools";
import { orgMemoryToolDefs } from "@mimir/plugin-core/tools/org-memory";
import {
  buildUserContext,
  type ToolDefinition,
  userMemoryToolDefs,
} from "@mimir/plugin-core/tools/user-memory";
import { errMessage } from "@mimir/plugin-core/util";
import type { Backend } from "../backends/types";
import type { CartographerManager } from "../cartographer/lifecycle";
import { isFileWriteTool } from "../cartographer/lifecycle";
import type { MimirConfig } from "../config";
import { ensureEngineReady, getSystemPrompt } from "../engine-boot";
import { createRequestToolPermission } from "../permissions";
import { assertNever } from "../utils/assert";
import { createChildLogger, log } from "../utils/log";
import { sharedEmbedQuery } from "./brain";
import { clientToolDefs } from "./client-tools";
import { acpBlocksToOpenAIContent, hasImageContent } from "./content";
import { emitAgentText } from "./lifecycle-helpers";
import { dispatchToolCall } from "./tool-dispatch";
import {
  buildToolCallContent,
  extractLocations,
  toolKindFor,
  toolTitle,
} from "./tool-reporting";
import { buildLocalContextInjection, todoWriteToolDef } from "./turn-context";
import type { SessionState } from "./types";

const logger = createChildLogger(log, "prompt-server");

const MAX_TURNS = 50;

export type PromptViaServerOptions = {
  readonly session: SessionState;
  readonly promptText: string;
  readonly conn: acp.AgentSideConnection;
  readonly abortController: AbortController;
  readonly backend: Backend;
  readonly appConfig: MimirConfig;
  readonly memoryStore: UserMemoryStore;
  readonly cartographer?: CartographerManager | null;
  readonly promptBlocks?: readonly acp.ContentBlock[];
  /** Local org replica for context retrieval + org-memory tools. */
  readonly replica?: OrgReplica | null;
};

export const promptViaServer = async (opts: PromptViaServerOptions) => {
  const {
    session,
    promptText,
    conn,
    abortController,
    backend,
    appConfig,
    memoryStore,
    cartographer,
    promptBlocks,
    replica,
  } = opts;

  // When the user's prompt includes images, send multipart content so the
  // model can see them. Otherwise plain text keeps the payload small.
  const userContent =
    promptBlocks && promptBlocks.length > 0 && hasImageContent(promptBlocks)
      ? acpBlocksToOpenAIContent(promptBlocks)
      : promptText;
  session.messages.push({ role: "user", content: userContent });

  const requestToolPermission = createRequestToolPermission(
    conn,
    session.sessionId,
  );

  // Engine boot + system prompt were kicked off at agent creation —
  // re-await here so the first turn never races the registry, and a boot
  // failure surfaces on this turn rather than crashing the agent.
  await ensureEngineReady().catch((err) =>
    logger.error("engine boot failed:", errMessage(err)),
  );
  const [systemPrompt, clientMcpTools] = await Promise.all([
    getSystemPrompt(appConfig),
    session.clientMcp?.getToolDefs() ?? Promise.resolve([] as ToolDefinition[]),
  ]);

  // Fully local tool manifest (MIM-89): org memory + playbooks over the
  // replica, cartographer, user memory, client-forwarded, client MCP,
  // and the local TodoWrite plan tool.
  const allTools: ToolDefinition[] = [
    ...(replica ? orgMemoryToolDefs : []),
    ...(cartographer ? cartToolDefs : []),
    ...userMemoryToolDefs,
    ...clientToolDefs,
    ...clientMcpTools,
    todoWriteToolDef,
  ];

  // Per-turn local context assembly: replica retrieval (hybrid — the
  // shared embedder supplies the vector leg, FTS-only when it's
  // unavailable) + user profile + project rules, composed into ONE
  // synthetic injection pair. Retrieval failure is non-fatal: the turn
  // runs without memories.
  const retrieved = replica
    ? await retrieveLocalContext(replica, promptText, {
        projectId: session.projectId ?? undefined,
        embedQuery: sharedEmbedQuery(),
      }).catch((err) => {
        logger.warn("local context retrieval failed:", errMessage(err));
        return { contextBlock: "", memoryCount: 0, summaryCount: 0 };
      })
    : { contextBlock: "", memoryCount: 0, summaryCount: 0 };
  const contextInjection = buildLocalContextInjection(
    retrieved.contextBlock,
    buildUserContext(memoryStore),
    session.projectRules,
  );

  let turnCount = 0;
  let filesModified = false;
  // Last finish event's usage — returned to core.prompt so the post-turn
  // brain work can decide whether compaction is due.
  let lastPromptTokens: number | undefined;
  let lastContextWindow: number | undefined;

  while (turnCount < MAX_TURNS) {
    turnCount++;
    const pendingToolCalls: {
      id: string;
      name: string;
      input: Record<string, unknown>;
    }[] = [];
    let contentBuffer = "";
    let hasContent = false;

    // Manually drive the backend stream. `iter.next().catch(errMessage)`
    // makes abort vs real error explicit without try/catch wrapping the
    // whole loop. The injection pair rides ahead of the session history
    // on every invocation without ever entering session.messages.
    const iter = backend
      .run({
        prompt: promptText,
        systemPrompt,
        messages: [...contextInjection, ...session.messages],
        tools: allTools,
        projectPath: session.projectPath,
        modelId: session.currentModelId,
        effort: session.currentThoughtLevel,
        signal: abortController.signal,
        requestToolPermission,
      })
      [Symbol.asyncIterator]();

    let streamErrored = false;
    while (true) {
      const step = await iter.next().catch(errMessage);
      if (typeof step === "string") {
        if (abortController.signal.aborted) {
          return { stopReason: "cancelled" as const, filesModified };
        }
        logger.error("Agent loop error:", step);
        await emitAgentText(conn, session.sessionId, `Error: ${step}`);
        return { stopReason: "refusal" as const, filesModified };
      }
      if (step.done) break;
      const event = step.value;

      switch (event.type) {
        case "text":
          hasContent = true;
          contentBuffer += event.text;
          await emitAgentText(conn, session.sessionId, event.text);
          break;
        case "thinking":
          await conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_thought_chunk",
              content: { type: "text", text: event.text },
            },
          });
          break;
        case "tool_call":
          pendingToolCalls.push({
            id: event.id,
            name: event.name,
            input: event.input,
          });
          break;
        case "finish":
          if (typeof event.promptTokens === "number" && event.promptTokens > 0)
            lastPromptTokens = event.promptTokens;
          if (
            typeof event.contextWindow === "number" &&
            event.contextWindow > 0
          )
            lastContextWindow = event.contextWindow;
          // Emit a usage_update so Zed's progress bar updates per turn.
          // The local backend reports tokens from streamTurn's finish and
          // the context window from the registry's model metadata.
          if (
            typeof event.promptTokens === "number" &&
            event.promptTokens > 0 &&
            typeof event.contextWindow === "number" &&
            event.contextWindow > 0
          ) {
            await conn.sessionUpdate({
              sessionId: session.sessionId,
              update: {
                sessionUpdate: "usage_update",
                used: event.promptTokens,
                size: event.contextWindow,
              },
            });
          }
          break;
        case "error":
          logger.error("Backend error:", event.error);
          await emitAgentText(conn, session.sessionId, `Error: ${event.error}`);
          streamErrored = true;
          break;
        default:
          assertNever(event);
      }
      if (streamErrored) break;
    }
    if (streamErrored) return { stopReason: "refusal" as const, filesModified };

    if (pendingToolCalls.length === 0) {
      if (hasContent) {
        session.messages.push({ role: "assistant", content: contentBuffer });
      }
      return {
        stopReason: "end_turn" as const,
        filesModified,
        promptTokens: lastPromptTokens,
        contextWindow: lastContextWindow,
      };
    }

    // Push assistant turn with tool_calls
    session.messages.push({
      role: "assistant",
      content: hasContent ? contentBuffer : null,
      tool_calls: pendingToolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.input) },
      })),
    });

    // Check abort before starting tool execution.
    if (abortController.signal.aborted) {
      return { stopReason: "cancelled" as const, filesModified };
    }

    const supportsTerminalOutput =
      session.clientCapabilities._meta?.terminal_output === true;

    // Execute each tool sequentially so permission requests don't stack
    // multiple overlapping dialogs in the client UI.
    for (const tc of pendingToolCalls) {
      if (abortController.signal.aborted) {
        session.messages.push({
          role: "tool",
          content: "Aborted by user.",
          tool_call_id: tc.id,
          name: tc.name,
        });
        continue;
      }

      const kind = toolKindFor(tc.name);
      const locations = extractLocations(tc.name, tc.input);
      const title = toolTitle(tc.name, tc.input);

      // Build content eagerly — Edit/Write diffs only need the input args,
      // so they render immediately when the tool card appears.
      const eagerContent = buildToolCallContent(tc.name, tc.input, "") ?? [];

      // Initial tool_call notification with in_progress status
      await conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: tc.id,
          title,
          rawInput: tc.input,
          kind,
          status: "in_progress" as const,
          content: eagerContent,
          ...(locations ? { locations } : {}),
        },
      });

      // Permission gate — auto-approve read/search tools and tools the
      // user permanently allowed earlier in this session. Everything else
      // goes through the ACP permission dialog.
      const isAutoApproved =
        kind === "read" ||
        kind === "search" ||
        session.permanentlyAllowedTools.has(tc.name);

      if (!isAutoApproved) {
        const permission = await requestToolPermission({
          toolCallId: tc.id,
          toolName: tc.name,
          title,
          input: tc.input,
        });

        if (!permission.allowed) {
          const denialMessage =
            permission.message ?? "Permission denied by user.";
          session.messages.push({
            role: "tool",
            content: denialMessage,
            tool_call_id: tc.id,
            name: tc.name,
          });
          await conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "tool_call_update",
              toolCallId: tc.id,
              rawOutput: { content: denialMessage },
              status: "completed" as const,
            },
          });
          continue;
        }

        if (permission.permanent) {
          session.permanentlyAllowedTools.add(tc.name);
        }
      }

      // Rule-detector intercept — backend-agnostic engine evaluates
      // session.rules against this tool call and (if any fired) returns
      // a formatted nudge. Tool execution proceeds either way (warn-only
      // semantics matching the CC backend); findings get prepended to
      // the tool_result so the model reads the violation text alongside
      // the actual output. Empty `session.rules` makes this a no-op.
      const ruleNudge = await runAndFormat(session.rules, {
        toolName: tc.name,
        toolInput: tc.input,
        projectPath: session.projectPath,
      });

      const isFileWrite = isFileWriteTool(tc.name);
      const resultContent = await dispatchToolCall(tc, {
        session,
        conn,
        memoryStore,
        replica,
        cartographer,
        abortSignal: abortController.signal,
        supportsTerminalOutput,
      });

      // Prepend any rule-violation nudge to the tool result so the
      // model reads it before the actual output. Separator keeps the
      // boundary visible to both the model and any human reviewing the
      // transcript.
      const finalResult = ruleNudge
        ? `${ruleNudge}\n\n---\n\n${resultContent}`
        : resultContent;

      if (isFileWrite) filesModified = true;

      session.messages.push({
        role: "tool",
        content: finalResult,
        tool_call_id: tc.id,
        name: tc.name,
      });

      // Incremental update — `rawOutput` carries the same value the
      // model just received (rule nudge prepended when present), so the
      // editor's tool-result view stays in sync with what the next
      // assistant turn will see.
      const content = buildToolCallContent(tc.name, tc.input, finalResult);
      await conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: tc.id,
          rawOutput: { content: finalResult },
          status: "completed" as const,
          ...(content ? { content } : {}),
        },
      });
    }
  }

  // Loop falls through only when the `turnCount < MAX_TURNS` condition
  // becomes false — every other exit goes through an early return inside
  // the body. So reaching here means we hit the cap.
  logger.warn("Max turns reached:", MAX_TURNS);
  return { stopReason: "max_turn_requests" as const, filesModified };
};
