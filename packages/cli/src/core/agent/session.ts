import {
  type CanUseTool,
  type PermissionResult,
  query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { McpServerEntry } from "@mimir/plugin-core/mcp/config-file";
import type { PermissionMode } from "../config/schema.ts";
import type { LocalPlugin } from "../resources/plugins.ts";
import type { Action } from "../store/actions.ts";

export type SessionOptions = {
  model?: string;
  permissionMode: PermissionMode;
  mcpServers: Record<string, McpServerEntry>;
  plugins: LocalPlugin[];
};

const DENIED_BY_USER = "denied by the user";
const DENIED_ABORTED = "request aborted before the user answered";

/**
 * Parks each canUseTool promise until main answers with `agent/permission`.
 * An abort from the SDK resolves it as a deny and tells main to drop the prompt.
 */
const createPermissionGate = (emit: (action: Action) => void) => {
  const pending = new Map<string, (result: PermissionResult) => void>();

  const canUseTool: CanUseTool = (toolName, input, options) =>
    new Promise((resolve) => {
      const { toolUseID: id, decisionReason, signal } = options;
      pending.set(id, resolve);
      signal.addEventListener("abort", () => {
        if (pending.delete(id)) {
          resolve({ behavior: "deny", message: DENIED_ABORTED });
          emit({ type: "permission/cancelled", id });
        }
      });
      const description = input.description;
      emit({
        type: "permission/requested",
        request: {
          id,
          toolName,
          input,
          ...(typeof description === "string"
            ? { reasoning: description }
            : {}),
          ...(decisionReason === undefined ? {} : { decisionReason }),
        },
      });
    });

  const answer = (id: string, behavior: "allow" | "deny") => {
    const resolve = pending.get(id);
    if (resolve === undefined) {
      return;
    }
    pending.delete(id);
    resolve(
      behavior === "allow"
        ? { behavior: "allow" }
        : { behavior: "deny", message: DENIED_BY_USER },
    );
  };

  return { canUseTool, answer };
};

/** Push-based async queue: `push` feeds the SDK's streaming-input iterable. */
const createInputQueue = () => {
  const pending: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  const push = (message: SDKUserMessage) => {
    pending.push(message);
    wake?.();
  };
  const close = () => {
    closed = true;
    wake?.();
  };
  const iterable: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const next = pending.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (closed) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    },
  };
  return { push, close, iterable };
};

const userMessage = (text: string) =>
  ({
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
  }) satisfies SDKUserMessage;

const toActions = (message: SDKMessage) => {
  const actions: Action[] = [];
  switch (message.type) {
    case "stream_event": {
      const event = message.event;
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        actions.push({ type: "agent/text-delta", text: event.delta.text });
      } else if (event.type === "content_block_stop") {
        actions.push({ type: "agent/block-end" });
      }
      break;
    }
    case "assistant": {
      for (const block of message.message.content) {
        if (block.type === "tool_use") {
          actions.push({ type: "agent/tool-use", name: block.name });
        }
      }
      if (message.error !== undefined) {
        actions.push({ type: "agent/error", message: message.error });
      }
      break;
    }
    case "result": {
      if (message.is_error) {
        actions.push({ type: "agent/error", message: message.subtype });
      }
      actions.push({ type: "agent/turn-end" });
      break;
    }
    default:
      break;
  }
  return actions;
};

export const startSession = (
  options: SessionOptions,
  emit: (action: Action) => void,
) => {
  const input = createInputQueue();
  const permissions = createPermissionGate(emit);
  const session = query({
    prompt: input.iterable,
    options: {
      includePartialMessages: true,
      model: options.model,
      permissionMode: options.permissionMode,
      // User settings (~/.claude/settings.json) can carry a defaultMode such
      // as "auto" that pre-empts canUseTool; the programmatic settings layer
      // outranks the filesystem ones, so pin the mode there as well.
      settings: { permissions: { defaultMode: options.permissionMode } },
      mcpServers: options.mcpServers,
      plugins: options.plugins,
      canUseTool: permissions.canUseTool,
    },
  });

  const consume = async () => {
    for await (const message of session) {
      for (const action of toActions(message)) {
        emit(action);
      }
    }
  };
  consume().catch((error: unknown) => {
    emit({
      type: "agent/error",
      message: error instanceof Error ? error.message : String(error),
    });
  });

  return {
    send: (text: string) => input.push(userMessage(text)),
    answerPermission: permissions.answer,
    close: () => {
      input.close();
      session.close();
    },
  };
};
