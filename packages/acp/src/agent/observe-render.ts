/**
 * Rendering for observe-only tool events from the server backend.
 *
 * The server executes its own tools and emits observeOnly tool_call /
 * tool_result events so the editor can show what ran without re-executing.
 * Most observations render as a tool card; TodoWrite renders as a plan-panel
 * update instead. Extracted from prompt-server.ts to keep that file within the
 * length budget and to keep the observe-rendering concern in one place.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { BackendEvent } from "../backends/types";
import { emitPlanUpdate } from "./lifecycle-helpers";
import {
  buildToolCallContent,
  extractLocations,
  toolKindFor,
  toolTitle,
} from "./tool-reporting";

/** Metadata retained between an observed call and its paired result. */
export type ObservedCall = {
  name: string;
  kind: acp.ToolKind;
  title: string;
};

type ObserveToolCall = Extract<BackendEvent, { type: "tool_call" }>;
type ObserveToolResult = Extract<BackendEvent, { type: "tool_result" }>;

/**
 * Render an observed tool_call. TodoWrite becomes a plan-panel update (no
 * card); everything else becomes an in-progress tool card tracked in
 * `observedCalls` so the paired result can complete it.
 */
export const renderObservedToolCall = async (
  conn: acp.AgentSideConnection,
  sessionId: string,
  event: ObserveToolCall,
  observedCalls: Map<string, ObservedCall>,
) => {
  if (event.name === "TodoWrite" && Array.isArray(event.input.todos)) {
    await emitPlanUpdate(
      conn,
      sessionId,
      event.input.todos as {
        content: string;
        status: string;
        activeForm?: string;
      }[],
    );
    return;
  }

  const kind = toolKindFor(event.name);
  const title = toolTitle(event.name, event.input);
  const locations = extractLocations(event.name, event.input);
  const eagerContent = buildToolCallContent(event.name, event.input, "") ?? [];
  await conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: event.id,
      title,
      rawInput: event.input,
      kind,
      status: "in_progress" as const,
      content: eagerContent,
      ...(locations ? { locations } : {}),
    },
  });
  observedCalls.set(event.id, { name: event.name, kind, title });
};

/** Complete an observed tool card when its paired result arrives. */
export const completeObservedToolCall = async (
  conn: acp.AgentSideConnection,
  sessionId: string,
  event: ObserveToolResult,
  observedCalls: Map<string, ObservedCall>,
) => {
  const callMeta = observedCalls.get(event.id);
  if (!callMeta) return;
  const content = buildToolCallContent(callMeta.name, {}, event.output);
  await conn.sessionUpdate({
    sessionId,
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: event.id,
      rawOutput: { content: event.output },
      status: "completed" as const,
      ...(content ? { content } : {}),
    },
  });
  observedCalls.delete(event.id);
};
