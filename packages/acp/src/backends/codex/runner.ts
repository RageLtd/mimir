/**
 * Core Codex runner using @openai/codex-sdk.
 */

import { Codex, type ThreadEvent, type ThreadItem } from "@openai/codex-sdk";
import { errMessage } from "../../util";
import { createChildLogger, log } from "../../utils/log";
import type { BackendEvent } from "../types";
import {
  buildCodexOptions,
  buildCodexThreadOptions,
  type RunCodexOptions,
} from "./formatting";

const logger = createChildLogger(log, "codex-runner");

const stringifyMcpResult = (
  result: Extract<ThreadItem, { type: "mcp_tool_call" }>["result"],
) => {
  if (!result) return "";
  const parts = result.content.map((part) => {
    if (part.type === "text") return part.text;
    return JSON.stringify(part);
  });
  if (result.structured_content !== undefined) {
    parts.push(JSON.stringify(result.structured_content));
  }
  return parts.join("\n");
};

const toolInputForItem = (item: ThreadItem) => {
  if (item.type === "command_execution") {
    return { command: item.command };
  }
  if (item.type === "file_change") {
    return { changes: item.changes };
  }
  if (item.type === "mcp_tool_call") {
    return {
      server: item.server,
      tool: item.tool,
      arguments: item.arguments,
    };
  }
  if (item.type === "web_search") {
    return { query: item.query };
  }
  if (item.type === "todo_list") {
    return {
      todos: item.items.map((todo) => ({
        content: todo.text,
        status: todo.completed ? "completed" : "pending",
      })),
    };
  }
  return {};
};

const toolNameForItem = (item: ThreadItem) => {
  if (item.type === "command_execution") return "terminal";
  if (item.type === "file_change") return "codex_file_change";
  if (item.type === "mcp_tool_call") return `${item.server}.${item.tool}`;
  if (item.type === "web_search") return "web_search";
  if (item.type === "todo_list") return "TodoWrite";
  return item.type;
};

const toolOutputForItem = (item: ThreadItem) => {
  if (item.type === "command_execution") return item.aggregated_output;
  if (item.type === "file_change") {
    return item.changes
      .map((change) => `${change.kind} ${change.path}`)
      .join("\n");
  }
  if (item.type === "mcp_tool_call") {
    return item.error?.message ?? stringifyMcpResult(item.result);
  }
  if (item.type === "web_search") return item.query;
  if (item.type === "todo_list") {
    return item.items
      .map((todo) => `${todo.completed ? "[x]" : "[ ]"} ${todo.text}`)
      .join("\n");
  }
  if (item.type === "error") return item.message;
  return "";
};

type CodexEventTranslatorState = {
  readonly textByItemId: Map<string, string>;
};

const createTranslatorState = () => ({
  textByItemId: new Map<string, string>(),
});

function* translateTextDelta(
  state: CodexEventTranslatorState,
  item: Extract<ThreadItem, { type: "agent_message" | "reasoning" }>,
) {
  const previous = state.textByItemId.get(item.id) ?? "";
  state.textByItemId.set(item.id, item.text);

  if (!item.text.startsWith(previous)) {
    if (item.type === "agent_message") {
      yield { type: "text" as const, text: item.text };
    } else {
      yield { type: "thinking" as const, text: item.text };
    }
    return;
  }

  const delta = item.text.slice(previous.length);
  if (delta.length === 0) return;
  if (item.type === "agent_message") {
    yield { type: "text" as const, text: delta };
  } else {
    yield { type: "thinking" as const, text: delta };
  }
}

function* translateItemStarted(item: ThreadItem) {
  if (
    item.type !== "command_execution" &&
    item.type !== "file_change" &&
    item.type !== "mcp_tool_call" &&
    item.type !== "web_search" &&
    item.type !== "todo_list"
  ) {
    return;
  }
  yield {
    type: "tool_call" as const,
    id: item.id,
    name: toolNameForItem(item),
    input: toolInputForItem(item),
    observeOnly: true,
  };
}

function* translateItemUpdated(
  state: CodexEventTranslatorState,
  item: ThreadItem,
) {
  if (item.type === "agent_message" || item.type === "reasoning") {
    yield* translateTextDelta(state, item);
  }
}

function* translateItemCompleted(
  state: CodexEventTranslatorState,
  item: ThreadItem,
) {
  if (item.type === "agent_message" || item.type === "reasoning") {
    yield* translateTextDelta(state, item);
    return;
  }
  if (item.type === "error") {
    yield { type: "error" as const, error: item.message };
    return;
  }
  if (
    item.type === "command_execution" ||
    item.type === "file_change" ||
    item.type === "mcp_tool_call" ||
    item.type === "web_search" ||
    item.type === "todo_list"
  ) {
    yield {
      type: "tool_result" as const,
      id: item.id,
      output: toolOutputForItem(item),
      observeOnly: true,
    };
  }
}

function* translateCodexEvent(
  state: CodexEventTranslatorState,
  event: ThreadEvent,
) {
  if (event.type === "thread.started") {
    yield {
      type: "init" as const,
      sessionId: event.thread_id,
      tools: [],
    };
    return;
  }
  if (event.type === "item.started") {
    yield* translateItemStarted(event.item);
    return;
  }
  if (event.type === "item.updated") {
    yield* translateItemUpdated(state, event.item);
    return;
  }
  if (event.type === "item.completed") {
    yield* translateItemCompleted(state, event.item);
    return;
  }
  if (event.type === "turn.completed") {
    yield {
      type: "finish" as const,
      promptTokens: event.usage.input_tokens + event.usage.cached_input_tokens,
      completionTokens: event.usage.output_tokens,
    };
    return;
  }
  if (event.type === "turn.failed") {
    yield {
      type: "finish" as const,
      stopReason: "failed",
      errors: [event.error.message],
    };
    return;
  }
  if (event.type === "error") {
    yield { type: "error" as const, error: event.message };
  }
}

export const createCodexEventTranslator = () => {
  const state = createTranslatorState();
  return function* translate(event: ThreadEvent) {
    yield* translateCodexEvent(state, event);
  };
};

export const runCodex = async function* (
  options: RunCodexOptions,
): AsyncGenerator<BackendEvent> {
  const codex = new Codex(buildCodexOptions(options));
  const thread = codex.startThread(buildCodexThreadOptions(options));
  const streamed = await thread
    .runStreamed(options.prompt, { signal: options.signal })
    .catch(errMessage);

  if (typeof streamed === "string") {
    yield { type: "error" as const, error: streamed };
    return;
  }

  const translate = createCodexEventTranslator();
  for await (const event of streamed.events) {
    logger.debug({ type: event.type }, "Codex event");
    yield* translate(event);
  }
};

export const runCodexThread = async function* (
  thread: import("@openai/codex-sdk").Thread,
  prompt: string,
  signal: AbortSignal | undefined,
): AsyncGenerator<BackendEvent> {
  const streamed = await thread
    .runStreamed(prompt, { signal })
    .catch(errMessage);
  if (typeof streamed === "string") {
    yield { type: "error" as const, error: streamed };
    return;
  }
  const translate = createCodexEventTranslator();
  for await (const event of streamed.events) {
    logger.debug({ type: event.type }, "Codex event");
    yield* translate(event);
  }
};

export const createCodexThread = (options: RunCodexOptions) => {
  const codex = new Codex(buildCodexOptions(options));
  return codex.startThread(buildCodexThreadOptions(options));
};
