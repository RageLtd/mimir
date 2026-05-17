/**
 * Server backend prompt path.
 *
 * Sends messages + tool manifest to mimir-server, streams text to the
 * editor, executes tool calls (local or editor-forwarded), and loops
 * until the model finishes without requesting tools.
 *
 * Why this path doesn't call `persistTurn` / `reportTokenUsage`:
 *   mimir-server owns all transcript writes for this backend. Specifically:
 *   - User + tool messages → `appendTrailingTurn` in
 *     `middleware/context-assembly.ts` (request-time, before the agent loop).
 *   - Assistant messages → `persistAssistantTurn` in `agent/run/loop.ts` /
 *     `response.ts` (post-stream).
 *   - Token tracking + compaction → `triggerCompactionIfNeeded` (post-stream).
 *   - Memory extraction → `extractMemoriesFromResponse` (post-stream).
 *   The CC backend has to call `/v1/messages/persist` and
 *   `/v1/context/token-report` itself because it runs inference locally and
 *   the server never sees its assistant emissions; the server backend gets
 *   all of that for free at the `/v1/chat/completions` boundary.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { Backend } from "../backends/types";
import type { CartographerManager } from "../cartographer/lifecycle";
import {
  isFileWriteTool,
  isLocalCartographerTool,
} from "../cartographer/lifecycle";
import type { MimirConfig } from "../config";
import { createRequestToolPermission } from "../permissions";
import { runAndFormat } from "../rules";
import { getTools, type ToolDefinition } from "../server-client";
import type { UserMemoryStore } from "../store/user-memories";
import {
  buildUserContext,
  executeUserMemoryTool,
  userMemoryToolDefs,
  userMemoryToolNames,
} from "../tools/user-memory";
import { errMessage } from "../util";
import { createChildLogger, log } from "../utils/log";
import {
  clientToolDefs,
  clientToolNames,
  executeClientTool,
} from "./client-tools";
import {
  acpBlocksToOpenAIContent,
  buildMetadata,
  hasImageContent,
} from "./content";
import { emitAgentText, emitPlanUpdate } from "./lifecycle-helpers";
import {
  buildToolCallContent,
  extractLocations,
  toolKindFor,
  toolTitle,
} from "./tool-reporting";
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

  const [serverTools, clientMcpTools] = await Promise.all([
    getTools(
      { baseUrl: appConfig.serverUrl, apiKey: appConfig.apiKey },
      abortController.signal,
    ),
    session.clientMcp?.getToolDefs() ?? Promise.resolve([] as ToolDefinition[]),
  ]);
  const allTools: ToolDefinition[] = [
    ...serverTools,
    ...userMemoryToolDefs,
    ...clientToolDefs,
    ...clientMcpTools,
  ];
  const userContext = buildUserContext(memoryStore);
  const metadata = buildMetadata(
    session.projectPath,
    session.projectId,
    userContext,
    session.projectRules,
  );

  let turnCount = 0;
  let filesModified = false;

  while (turnCount < MAX_TURNS) {
    turnCount++;
    const pendingToolCalls: {
      id: string;
      name: string;
      input: Record<string, unknown>;
    }[] = [];
    let contentBuffer = "";
    let hasContent = false;

    // Manually drive the backend stream — same pattern as prompt-cc.ts.
    // `iter.next().catch(errMessage)` makes abort vs real error explicit
    // without try/catch wrapping the whole loop.
    const iter = backend
      .run({
        prompt: promptText,
        systemPrompt: "",
        messages: session.messages,
        tools: allTools,
        projectPath: session.projectPath,
        metadata,
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

      if (event.type === "text") {
        hasContent = true;
        contentBuffer += event.text;
        await emitAgentText(conn, session.sessionId, event.text);
      } else if (event.type === "thinking") {
        await conn.sessionUpdate({
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: event.text },
          },
        });
      } else if (event.type === "tool_call" && !event.observeOnly) {
        pendingToolCalls.push({
          id: event.id,
          name: event.name,
          input: event.input,
        });
      } else if (event.type === "finish") {
        // Emit a usage_update so Zed's progress bar updates per turn —
        // mirrors prompt-cc.ts:248. The server backend now reports
        // tokens + context window via the trailing usage chunk that
        // backends/server.ts buffers into this finish event.
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
      } else if (event.type === "error") {
        logger.error("Backend error:", event.error);
        await emitAgentText(conn, session.sessionId, `Error: ${event.error}`);
        streamErrored = true;
        break;
      }
    }
    if (streamErrored) return { stopReason: "refusal" as const, filesModified };

    if (pendingToolCalls.length === 0) {
      if (hasContent) {
        session.messages.push({ role: "assistant", content: contentBuffer });
      }
      return { stopReason: "end_turn" as const, filesModified };
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

      let resultContent: string;
      const isFileWrite = isFileWriteTool(tc.name);

      if (userMemoryToolNames.has(tc.name)) {
        const result = executeUserMemoryTool(memoryStore, tc.name, tc.input);
        resultContent = result.content;
      } else if (cartographer && isLocalCartographerTool(tc.name)) {
        // Two-arg .then() to preserve success-vs-error distinction without
        // try/catch — errMessage() narrows thrown Errors to a string, and
        // we wrap the success path in `{ ok: true }` so the caller can tell
        // a real "" tool output apart from a raised exception.
        const outcome = await cartographer.executeTool(tc.name, tc.input).then(
          (data) => ({ ok: true as const, data }),
          (err) => ({ ok: false as const, error: errMessage(err) }),
        );
        if (outcome.ok) {
          resultContent = outcome.data;
        } else {
          logger.error("Cartographer tool error:", outcome.error);
          resultContent = `Error executing ${tc.name}: ${outcome.error}`;
        }
      } else if (clientToolNames.has(tc.name)) {
        const isTerminal =
          tc.name === "create_terminal" || tc.name === "terminal";
        resultContent = await executeClientTool(
          tc.name,
          tc.input,
          session.sessionId,
          conn,
          {
            abortSignal: abortController.signal,
            onTerminalOutput:
              isTerminal && supportsTerminalOutput
                ? async (output) => {
                    await conn.sessionUpdate({
                      sessionId: session.sessionId,
                      update: {
                        _meta: {
                          terminal_output: {
                            terminal_id: tc.id,
                            data: output,
                          },
                        },
                        sessionUpdate: "tool_call_update",
                        toolCallId: tc.id,
                      },
                    });
                  }
                : undefined,
          },
        );
      } else if (session.clientMcp?.owns(tc.name)) {
        resultContent = await session.clientMcp
          .callTool(tc.name, tc.input)
          .catch((err) => {
            const msg = errMessage(err);
            logger.error("Client MCP tool error:", msg);
            return `Error executing ${tc.name}: ${msg}`;
          });
      } else {
        logger.warn("Unknown tool call:", tc.name);
        resultContent = `Tool ${tc.name} is not available in this adapter.`;
      }

      // Prepend any rule-violation nudge to the tool result so the
      // model reads it before the actual output. Separator keeps the
      // boundary visible to both the model and any human reviewing the
      // transcript.
      const finalResult = ruleNudge
        ? `${ruleNudge}\n\n---\n\n${resultContent}`
        : resultContent;

      if (isFileWrite) filesModified = true;

      // TodoWrite → emit a plan update so Zed's plan panel stays in sync,
      // mirroring the CC event handler's behaviour.
      if (tc.name === "TodoWrite" && Array.isArray(tc.input.todos)) {
        await emitPlanUpdate(
          conn,
          session.sessionId,
          tc.input.todos as {
            content: string;
            status: string;
            activeForm?: string;
          }[],
        );
      }

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
