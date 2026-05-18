/**
 * Codex app-server ThreadItem types and helpers.
 *
 * Mirrors protocol/v2/ThreadItem.ts with the subset we need for event
 * translation. Extracted from app-server-events.ts to stay under the
 * 500-line file-length ceiling.
 */

import type { BackendEvent } from "../types";

// ---------------------------------------------------------------------------
// ThreadItem types — mirrors protocol/v2/ThreadItem.ts
// ---------------------------------------------------------------------------

export type AppServerTextItem = {
  readonly id: string;
  readonly type: "agentMessage";
  readonly text: string;
};

export type AppServerReasoningItem = {
  readonly id: string;
  readonly type: "reasoning";
  readonly content: readonly string[];
  readonly summary: readonly string[];
};

export type AppServerCommandItem = {
  readonly id: string;
  readonly type: "commandExecution";
  readonly command?: string | readonly string[];
  readonly aggregatedOutput?: string | null;
};

export type AppServerFileChangeItem = {
  readonly id: string;
  readonly type: "fileChange";
  readonly changes: readonly {
    readonly kind: string;
    readonly path: string;
    readonly diff?: string;
  }[];
};

export type AppServerMcpToolCallItem = {
  readonly id: string;
  readonly type: "mcpToolCall";
  readonly server: string;
  readonly tool: string;
  readonly arguments: unknown;
  readonly result?: {
    readonly content?: unknown;
    readonly structuredContent?: unknown;
    readonly structured_content?: unknown;
  } | null;
  readonly error?: { readonly message?: string } | null;
};

export type AppServerWebSearchItem = {
  readonly id: string;
  readonly type: "webSearch";
  readonly query: string;
};

export type AppServerDynamicToolCallItem = {
  readonly id: string;
  readonly type: "dynamicToolCall";
  readonly namespace: string | null;
  readonly tool: string;
  readonly arguments: unknown;
};

export type AppServerPlanItem = {
  readonly id: string;
  readonly type: "plan";
  readonly text: string;
};

// Item types we recognise but don't need to translate into BackendEvents.
// They're part of normal thread lifecycle and can be silently skipped.
export type AppServerPassthroughItem = {
  readonly id: string;
  readonly type:
    | "userMessage"
    | "hookPrompt"
    | "contextCompaction"
    | "imageView"
    | "imageGeneration"
    | "enteredReviewMode"
    | "exitedReviewMode"
    | "collabAgentToolCall";
};

export type AppServerToolItem =
  | AppServerCommandItem
  | AppServerFileChangeItem
  | AppServerMcpToolCallItem
  | AppServerWebSearchItem
  | AppServerDynamicToolCallItem;

export type AppServerItem =
  | AppServerTextItem
  | AppServerReasoningItem
  | AppServerCommandItem
  | AppServerFileChangeItem
  | AppServerMcpToolCallItem
  | AppServerWebSearchItem
  | AppServerDynamicToolCallItem
  | AppServerPlanItem
  | AppServerPassthroughItem;

// ---------------------------------------------------------------------------
// Translator state
// ---------------------------------------------------------------------------

export type AppServerTranslatorState = {
  readonly textByItemId: Map<string, string>;
  readonly outputByItemId: Map<string, string>;
  promptTokens: number;
  completionTokens: number;
  contextWindow: number | undefined;
};

export const createTranslatorState = () => ({
  textByItemId: new Map<string, string>(),
  outputByItemId: new Map<string, string>(),
  promptTokens: 0,
  completionTokens: 0,
  contextWindow: undefined,
});

// ---------------------------------------------------------------------------
// Item helpers
// ---------------------------------------------------------------------------

const commandText = (command: string | readonly string[] | undefined) => {
  if (Array.isArray(command)) return command.join(" ");
  return command ?? "";
};

export const isToolItem = (item: AppServerItem): item is AppServerToolItem =>
  item.type === "commandExecution" ||
  item.type === "fileChange" ||
  item.type === "mcpToolCall" ||
  item.type === "webSearch" ||
  item.type === "dynamicToolCall";

export const toolNameForItem = (item: AppServerToolItem) => {
  if (item.type === "commandExecution") return "terminal";
  if (item.type === "fileChange") return "codex_file_change";
  if (item.type === "mcpToolCall") return `${item.server}.${item.tool}`;
  if (item.type === "webSearch") return "web_search";
  return `${item.namespace ?? "dynamic"}.${item.tool}`;
};

export const toolInputForItem = (item: AppServerToolItem) => {
  if (item.type === "commandExecution") {
    return { command: commandText(item.command) };
  }
  if (item.type === "fileChange") {
    return { changes: item.changes };
  }
  if (item.type === "mcpToolCall") {
    return {
      server: item.server,
      tool: item.tool,
      arguments: item.arguments,
    };
  }
  if (item.type === "webSearch") {
    return { query: item.query };
  }
  return {
    namespace: item.namespace,
    tool: item.tool,
    arguments: item.arguments,
  };
};

const mcpResultOutput = (item: AppServerMcpToolCallItem) => {
  if (item.error?.message) return item.error.message;
  if (!item.result) return "";
  const structuredContent =
    item.result.structuredContent ?? item.result.structured_content;
  return JSON.stringify({
    content: item.result.content ?? [],
    ...(structuredContent === undefined || structuredContent === null
      ? {}
      : { structuredContent }),
  });
};

export const toolOutputForItem = (
  item: AppServerToolItem,
  state: AppServerTranslatorState,
) => {
  if (item.type === "commandExecution") {
    return item.aggregatedOutput ?? state.outputByItemId.get(item.id) ?? "";
  }
  if (item.type === "fileChange") {
    return item.changes
      .map((change) => `${change.kind} ${change.path}`)
      .join("\n");
  }
  if (item.type === "mcpToolCall") return mcpResultOutput(item);
  if (item.type === "webSearch") return item.query;
  return "";
};

// ---------------------------------------------------------------------------
// Completed-item translation
// ---------------------------------------------------------------------------

export function* translateCompletedText(
  state: AppServerTranslatorState,
  item: AppServerTextItem | AppServerReasoningItem,
) {
  const text = item.type === "agentMessage" ? item.text : item.content.join("");
  const previous = state.textByItemId.get(item.id) ?? "";
  state.textByItemId.set(item.id, text);
  if (text.length === 0) return;

  if (!text.startsWith(previous)) {
    yield {
      type: item.type === "agentMessage" ? "text" : "thinking",
      text,
    } satisfies BackendEvent;
    return;
  }

  const delta = text.slice(previous.length);
  if (delta.length === 0) return;
  yield {
    type: item.type === "agentMessage" ? "text" : "thinking",
    text: delta,
  } satisfies BackendEvent;
}

export function* translateStartedItem(item: AppServerItem) {
  if (!isToolItem(item)) return;
  yield {
    type: "tool_call",
    id: item.id,
    name: toolNameForItem(item),
    input: toolInputForItem(item),
    observeOnly: true,
  } satisfies BackendEvent;
}
