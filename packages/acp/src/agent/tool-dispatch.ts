/**
 * Local tool dispatch — routes one model-requested tool call to its
 * executor: org memory/playbooks over the replica, TodoWrite plan
 * rendering, user memory, cartographer, client-forwarded (editor) tools,
 * and client MCP. Extracted from prompt-server.ts to keep the agent loop
 * within the length budget and the name→executor mapping in one place.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { OrgReplica } from "@mimir/plugin-core/store/org-replica";
import type { UserMemoryStore } from "@mimir/plugin-core/store/user-memories";
import {
  executeOrgMemoryTool,
  orgMemoryToolNames,
} from "@mimir/plugin-core/tools/org-memory";
import {
  executeUserMemoryTool,
  userMemoryToolNames,
} from "@mimir/plugin-core/tools/user-memory";
import { errMessage } from "@mimir/plugin-core/util";
import type { CartographerManager } from "../cartographer/lifecycle";
import { isLocalCartographerTool } from "../cartographer/lifecycle";
import { createChildLogger, log } from "../utils/log";
import { sharedEmbedQuery } from "./brain";
import { clientToolNames, executeClientTool } from "./client-tools";
import { emitPlanUpdate } from "./lifecycle-helpers";
import { parseTodos } from "./turn-context";
import type { SessionState } from "./types";

const logger = createChildLogger(log, "tool-dispatch");

export type ToolDispatchContext = {
  readonly session: SessionState;
  readonly conn: acp.AgentSideConnection;
  readonly memoryStore: UserMemoryStore;
  readonly replica?: OrgReplica | null;
  readonly cartographer?: CartographerManager | null;
  readonly abortSignal: AbortSignal;
  readonly supportsTerminalOutput: boolean;
};

/**
 * Execute one tool call and return its textual result. Never throws —
 * executor failures come back as `Error executing …` strings so the
 * model can read them and the loop keeps going.
 */
export const dispatchToolCall = async (
  tc: { id: string; name: string; input: Record<string, unknown> },
  ctx: ToolDispatchContext,
) => {
  const { session, conn, memoryStore, replica, cartographer } = ctx;

  if (replica && orgMemoryToolNames.has(tc.name)) {
    // Org memory + playbooks execute against the local replica —
    // result payloads are server-identical (MIM-84 parity contract).
    // The shared embedder gives search/store their vector leg; FTS-only
    // degradation when the embedder is unavailable (MIM-85 seam).
    const result = await executeOrgMemoryTool(
      replica,
      tc.name,
      tc.input,
      sharedEmbedQuery(),
    );
    return result.content;
  }

  if (tc.name === "TodoWrite") {
    // Renders the editor's plan panel; no state kept (server plan-tool
    // semantics — acknowledge so the loop continues).
    const todos = parseTodos(tc.input.todos);
    if (!todos) return "TodoWrite input invalid: `todos` must be an array.";
    await emitPlanUpdate(conn, session.sessionId, todos);
    return `Plan recorded: ${todos.length} item${todos.length === 1 ? "" : "s"}.`;
  }

  if (userMemoryToolNames.has(tc.name)) {
    return executeUserMemoryTool(memoryStore, tc.name, tc.input).content;
  }

  if (cartographer && isLocalCartographerTool(tc.name)) {
    // Two-arg .then() to preserve success-vs-error distinction without
    // try/catch — errMessage() narrows thrown Errors to a string, and
    // we wrap the success path in `{ ok: true }` so the caller can tell
    // a real "" tool output apart from a raised exception.
    const outcome = await cartographer.executeTool(tc.name, tc.input).then(
      (data) => ({ ok: true as const, data }),
      (err) => ({ ok: false as const, error: errMessage(err) }),
    );
    if (outcome.ok) return outcome.data;
    logger.error("Cartographer tool error:", outcome.error);
    return `Error executing ${tc.name}: ${outcome.error}`;
  }

  if (clientToolNames.has(tc.name)) {
    const isTerminal = tc.name === "create_terminal" || tc.name === "terminal";
    return executeClientTool(tc.name, tc.input, session.sessionId, conn, {
      abortSignal: ctx.abortSignal,
      onTerminalOutput:
        isTerminal && ctx.supportsTerminalOutput
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
    });
  }

  if (session.clientMcp?.owns(tc.name)) {
    return session.clientMcp.callTool(tc.name, tc.input).catch((err) => {
      const msg = errMessage(err);
      logger.error("Client MCP tool error:", msg);
      return `Error executing ${tc.name}: ${msg}`;
    });
  }

  logger.warn("Unknown tool call:", tc.name);
  return `Tool ${tc.name} is not available in this adapter.`;
};
