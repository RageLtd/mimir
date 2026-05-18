import { createChildLogger, log } from "../../utils/log";
import type { BackendEvent } from "../types";
import {
  type AppServerItem,
  type AppServerTranslatorState,
  createTranslatorState,
  isToolItem,
  toolOutputForItem,
  translateCompletedText,
  translateStartedItem,
} from "./app-server-items";

const logger = createChildLogger(log, "codex-app-server-events");

// ---------------------------------------------------------------------------
// Notification types — canonical source: protocol/ServerNotification.ts
// ---------------------------------------------------------------------------

type DeltaParams = {
  readonly threadId?: string;
  readonly turnId?: string;
  readonly itemId: string;
  readonly delta: string;
};

type TokenBreakdown = {
  readonly input?: number;
  readonly output?: number;
  readonly cachedInput?: number;
  readonly reasoning?: number;
};

type TokenUsage = {
  readonly total: TokenBreakdown;
  readonly last: TokenBreakdown;
  readonly modelContextWindow: number | null;
};

type TurnError = {
  readonly message: string;
  readonly codexErrorInfo?: unknown;
  readonly additionalDetails?: string | null;
};

type Turn = {
  readonly id: string;
  readonly error: TurnError | null;
};

export type CodexAppServerNotification =
  | {
      readonly method: "error";
      readonly params: {
        readonly error: TurnError;
        readonly willRetry: boolean;
        readonly threadId: string;
        readonly turnId: string;
      };
    }
  | {
      readonly method: "thread/started";
      readonly params: { readonly thread: { readonly id: string } };
    }
  | {
      readonly method: "thread/status/changed";
      readonly params: Record<string, unknown>;
    }
  | {
      readonly method: "thread/tokenUsage/updated";
      readonly params: {
        readonly threadId: string;
        readonly turnId: string;
        readonly tokenUsage: TokenUsage;
      };
    }
  | {
      readonly method: "turn/started";
      readonly params: { readonly threadId: string; readonly turn: Turn };
    }
  | {
      readonly method: "turn/completed";
      readonly params: { readonly threadId: string; readonly turn: Turn };
    }
  | {
      readonly method: "item/started";
      readonly params: {
        readonly item: AppServerItem;
        readonly threadId: string;
        readonly turnId: string;
        readonly startedAtMs: number;
      };
    }
  | {
      readonly method: "item/completed";
      readonly params: {
        readonly item: AppServerItem;
        readonly threadId: string;
        readonly turnId: string;
        readonly completedAtMs: number;
      };
    }
  | { readonly method: "item/agentMessage/delta"; readonly params: DeltaParams }
  | {
      readonly method: "item/reasoning/textDelta";
      readonly params: DeltaParams;
    }
  | {
      readonly method: "item/reasoning/summaryTextDelta";
      readonly params: DeltaParams;
    }
  | {
      readonly method: "item/commandExecution/outputDelta";
      readonly params: DeltaParams;
    }
  | {
      readonly method: "item/fileChange/outputDelta";
      readonly params: DeltaParams;
    }
  | {
      readonly method: "item/fileChange/patchUpdated";
      readonly params: {
        readonly threadId: string;
        readonly turnId: string;
        readonly itemId: string;
        readonly patch: string;
      };
    }
  | {
      readonly method: "item/mcpToolCall/progress";
      readonly params: {
        readonly threadId: string;
        readonly turnId: string;
        readonly itemId: string;
        readonly progress?: number;
        readonly total?: number;
      };
    }
  | { readonly method: "item/plan/delta"; readonly params: DeltaParams }
  | {
      readonly method: "warning";
      readonly params: { readonly message: string };
    }
  | {
      readonly method: "configWarning";
      readonly params: { readonly message: string };
    };

// ---------------------------------------------------------------------------
// Completed-item translation (non-text/tool items)
// ---------------------------------------------------------------------------

function* translateCompletedItem(
  state: AppServerTranslatorState,
  item: AppServerItem,
) {
  if (item.type === "agentMessage" || item.type === "reasoning") {
    yield* translateCompletedText(state, item);
    return;
  }

  if (item.type === "plan") {
    const previous = state.textByItemId.get(item.id) ?? "";
    const delta = item.text.slice(previous.length);
    if (delta.length > 0) {
      yield { type: "text", text: delta } satisfies BackendEvent;
    }
    return;
  }

  if (isToolItem(item)) {
    yield {
      type: "tool_result",
      id: item.id,
      output: toolOutputForItem(item, state),
      observeOnly: true,
    } satisfies BackendEvent;
    return;
  }

  // Passthrough items (userMessage, hookPrompt, contextCompaction, etc.)
  logger.debug("skipping completed item type: %s", item.type);
}

// ---------------------------------------------------------------------------
// Notification translation
// ---------------------------------------------------------------------------

function* translateAppServerNotification(
  state: AppServerTranslatorState,
  notification: CodexAppServerNotification,
) {
  if (notification.method === "error") {
    const detail = notification.params.error.additionalDetails
      ? `${notification.params.error.message}: ${notification.params.error.additionalDetails}`
      : notification.params.error.message;
    yield { type: "error", error: detail } satisfies BackendEvent;
    if (!notification.params.willRetry) {
      yield {
        type: "finish",
        stopReason: "failed",
        errors: [detail],
      } satisfies BackendEvent;
    }
    return;
  }

  if (notification.method === "thread/started") {
    yield {
      type: "init",
      sessionId: notification.params.thread.id,
      tools: [],
    } satisfies BackendEvent;
    return;
  }

  if (notification.method === "thread/tokenUsage/updated") {
    const usage = notification.params.tokenUsage;
    state.promptTokens = usage.total.input ?? 0;
    state.completionTokens = usage.total.output ?? 0;
    if (usage.modelContextWindow !== null) {
      state.contextWindow = usage.modelContextWindow;
    }
    return;
  }

  if (notification.method === "turn/started") {
    logger.debug("turn started: %s", notification.params.turn.id);
    return;
  }

  if (notification.method === "thread/status/changed") {
    logger.debug("thread status changed: %o", notification.params);
    return;
  }

  if (
    notification.method === "warning" ||
    notification.method === "configWarning"
  ) {
    logger.warn("codex warning: %s", notification.params.message);
    return;
  }

  if (notification.method === "item/mcpToolCall/progress") {
    return;
  }

  if (notification.method === "item/started") {
    yield* translateStartedItem(notification.params.item);
    return;
  }

  if (notification.method === "item/completed") {
    yield* translateCompletedItem(state, notification.params.item);
    return;
  }

  if (notification.method === "item/agentMessage/delta") {
    const previous = state.textByItemId.get(notification.params.itemId) ?? "";
    state.textByItemId.set(
      notification.params.itemId,
      `${previous}${notification.params.delta}`,
    );
    yield {
      type: "text",
      text: notification.params.delta,
    } satisfies BackendEvent;
    return;
  }

  if (notification.method === "item/plan/delta") {
    const previous = state.textByItemId.get(notification.params.itemId) ?? "";
    state.textByItemId.set(
      notification.params.itemId,
      `${previous}${notification.params.delta}`,
    );
    yield {
      type: "text",
      text: notification.params.delta,
    } satisfies BackendEvent;
    return;
  }

  if (
    notification.method === "item/reasoning/textDelta" ||
    notification.method === "item/reasoning/summaryTextDelta"
  ) {
    const previous = state.textByItemId.get(notification.params.itemId) ?? "";
    state.textByItemId.set(
      notification.params.itemId,
      `${previous}${notification.params.delta}`,
    );
    yield {
      type: "thinking",
      text: notification.params.delta,
    } satisfies BackendEvent;
    return;
  }

  if (notification.method === "item/commandExecution/outputDelta") {
    const previous = state.outputByItemId.get(notification.params.itemId) ?? "";
    state.outputByItemId.set(
      notification.params.itemId,
      `${previous}${notification.params.delta}`,
    );
    yield {
      type: "tool_update",
      id: notification.params.itemId,
      output: notification.params.delta,
      observeOnly: true,
    } satisfies BackendEvent;
    return;
  }

  if (notification.method === "item/fileChange/outputDelta") {
    yield {
      type: "tool_update",
      id: notification.params.itemId,
      output: notification.params.delta,
      observeOnly: true,
    } satisfies BackendEvent;
    return;
  }

  if (notification.method === "item/fileChange/patchUpdated") {
    yield {
      type: "tool_update",
      id: notification.params.itemId,
      output: notification.params.patch,
      observeOnly: true,
    } satisfies BackendEvent;
    return;
  }

  if (notification.method === "turn/completed") {
    const turnError = notification.params.turn.error;
    yield {
      type: "finish",
      promptTokens: state.promptTokens,
      completionTokens: state.completionTokens,
      contextWindow: state.contextWindow,
      ...(turnError
        ? { stopReason: "failed", errors: [turnError.message] }
        : {}),
    } satisfies BackendEvent;
    return;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const createCodexAppServerEventTranslator = () => {
  const state = createTranslatorState();
  return function* translate(notification: CodexAppServerNotification) {
    yield* translateAppServerNotification(state, notification);
  };
};
