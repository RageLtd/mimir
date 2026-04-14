/**
 * Server backend prompt path.
 *
 * Sends messages + tool manifest to mimir-server, streams text to the
 * editor, executes tool calls (local or editor-forwarded), and loops
 * until the model finishes without requesting tools.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { Backend } from "../backends/types";
import type { CartographerManager } from "../cartographer/lifecycle";
import { isLocalCartographerTool } from "../cartographer/lifecycle";
import type { MimirConfig } from "../config";
import { getTools, type ToolDefinition } from "../server-client";
import type { UserMemoryStore } from "../store/user-memories";
import {
  executeUserMemoryTool,
  userMemoryToolDefs,
  userMemoryToolNames,
} from "../tools/user-memory";
import { createChildLogger, log } from "../utils/log";
import { executeClientTool } from "./client-tools";
import { buildMetadata } from "./content";
import {
  buildToolCallContent,
  extractLocations,
  isClientTool,
  toolKindFor,
  toolTitle,
} from "./tool-reporting";
import type { SessionState } from "./types";

const logger = createChildLogger(log, "prompt-server");

const MAX_TURNS = 50;

export const promptViaServer = async (
  session: SessionState,
  promptText: string,
  conn: acp.AgentSideConnection,
  abortController: AbortController,
  backend: Backend,
  appConfig: MimirConfig,
  memoryStore: UserMemoryStore,
  cartographer?: CartographerManager | null,
): Promise<acp.PromptResponse> => {
  session.messages.push({ role: "user", content: promptText });

  const serverTools = await getTools(
    { baseUrl: appConfig.serverUrl, apiKey: appConfig.apiKey },
    abortController.signal,
  );
  const allTools: ToolDefinition[] = [...serverTools, ...userMemoryToolDefs];
  const metadata = buildMetadata(session.projectPath);

  let turnCount = 0;

  while (turnCount < MAX_TURNS) {
    turnCount++;
    const pendingToolCalls: {
      id: string;
      name: string;
      input: Record<string, unknown>;
    }[] = [];
    let contentBuffer = "";
    let hasContent = false;

    try {
      for await (const event of backend.run({
        prompt: promptText,
        systemPrompt: "",
        messages: session.messages,
        tools: allTools,
        projectPath: session.projectPath,
        metadata,
        modelId: session.currentModelId,
        signal: abortController.signal,
      })) {
        if (event.type === "text") {
          hasContent = true;
          contentBuffer += event.text;
          await conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: event.text },
            },
          });
        } else if (event.type === "tool_call" && !event.observeOnly) {
          pendingToolCalls.push({
            id: event.id,
            name: event.name,
            input: event.input,
          });
        } else if (event.type === "error") {
          logger.error("Backend error:", event.error);
          await conn.sessionUpdate({
            sessionId: session.sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `Error: ${event.error}` },
            },
          });
          return { stopReason: "end_turn" };
        } else if (event.type === "finish") {
          // fall through to post-stream tool execution
        }
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        return { stopReason: "cancelled" };
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Agent loop error:", msg);
      return { stopReason: "end_turn" };
    }

    if (pendingToolCalls.length === 0) {
      return { stopReason: "end_turn" };
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

    // Execute each tool, push results, then loop and resubmit
    for (const tc of pendingToolCalls) {
      const kind = toolKindFor(tc.name);
      const locations = extractLocations(tc.name, tc.input);

      // Initial tool_call notification with in_progress status
      const title = toolTitle(tc.name, tc.input);
      await conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: tc.id,
          title,
          rawInput: tc.input,
          kind,
          status: "in_progress" as const,
          ...(locations ? { locations } : {}),
        },
      });

      let resultContent: string;
      if (userMemoryToolNames.has(tc.name)) {
        const result = executeUserMemoryTool(memoryStore, tc.name, tc.input);
        resultContent = result.content;
      } else if (cartographer && isLocalCartographerTool(tc.name)) {
        try {
          resultContent = await cartographer.executeTool(tc.name, tc.input);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error("Cartographer tool error:", msg);
          resultContent = `Error executing ${tc.name}: ${msg}`;
        }
      } else if (isClientTool(tc.name)) {
        resultContent = await executeClientTool(
          tc.name,
          tc.input,
          session.sessionId,
          conn,
        );
      } else {
        logger.warn("Unknown tool call:", tc.name);
        resultContent = `Tool ${tc.name} is not available in this adapter.`;
      }

      session.messages.push({
        role: "tool",
        content: resultContent,
        tool_call_id: tc.id,
        name: tc.name,
      });

      // Incremental update — only send changed fields
      const content = buildToolCallContent(tc.name, tc.input, resultContent);
      await conn.sessionUpdate({
        sessionId: session.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: tc.id,
          rawOutput: { content: resultContent },
          status: "completed" as const,
          ...(content ? { content } : {}),
        },
      });
    }
  }

  if (turnCount >= MAX_TURNS) {
    logger.warn("Max turns reached:", MAX_TURNS);
  }
  return { stopReason: "end_turn" };
};
