import { createPushQueue } from "../../utils/push-queue";
import type { CodexAppServerNotification } from "./app-server-events";

export type AppServerTransport = {
  readonly incoming: AsyncIterable<string>;
  readonly write: (data: string) => void | Promise<void>;
  readonly close?: () => void | Promise<void>;
};

export type AppServerRequest = {
  readonly id: string | number;
  readonly method: string;
  readonly params: Record<string, unknown>;
};

type PendingRequest = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
};

const NOTIFICATION_METHODS = new Set([
  "error",
  "thread/started",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/reasoning/textDelta",
  "item/reasoning/summaryTextDelta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/mcpToolCall/progress",
  "item/plan/delta",
  "warning",
  "configWarning",
]);

const SERVER_REQUEST_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/call",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "applyPatchApproval",
  "execCommandApproval",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const rpcIdKey = (id: unknown) => {
  if (typeof id === "string" || typeof id === "number") return String(id);
  return null;
};

const isNotification = (value: unknown): value is CodexAppServerNotification =>
  isRecord(value) &&
  typeof value.method === "string" &&
  NOTIFICATION_METHODS.has(value.method) &&
  isRecord(value.params);

const parseLine = (line: string) => {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  const parsed: unknown = JSON.parse(trimmed);
  if (!isRecord(parsed)) {
    throw new Error("Codex app-server sent a non-object JSON-RPC message");
  }
  return parsed;
};

const writeJsonLine = (
  transport: AppServerTransport,
  payload: Record<string, unknown>,
) => transport.write(`${JSON.stringify(payload)}\n`);

const rejectAll = (pending: Map<string, PendingRequest>, err: Error) => {
  for (const request of pending.values()) {
    request.reject(err);
  }
  pending.clear();
};

const handleMessage = (
  message: Record<string, unknown>,
  pending: Map<string, PendingRequest>,
  notifications: ReturnType<typeof createPushQueue<CodexAppServerNotification>>,
  serverRequests: ReturnType<typeof createPushQueue<AppServerRequest>>,
) => {
  const id = rpcIdKey(message.id);

  // Server-initiated request: has id + method, not in our pending map.
  // Must check method/id/params individually so TypeScript narrows the types.
  const method = message.method;
  if (
    id !== null &&
    !pending.has(id) &&
    typeof method === "string" &&
    SERVER_REQUEST_METHODS.has(method)
  ) {
    const params = message.params;
    if (isRecord(params)) {
      const rawId = message.id;
      if (typeof rawId === "string" || typeof rawId === "number") {
        serverRequests.push({ id: rawId, method, params });
        return;
      }
    }
  }

  // Response to one of our requests: has id, in pending map
  if (id !== null) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);

    if (isRecord(message.error)) {
      const detail =
        typeof message.error.message === "string"
          ? message.error.message
          : "Codex app-server request failed";
      request.reject(new Error(detail));
      return;
    }

    request.resolve(message.result);
    return;
  }

  // Notification: no id, known method
  if (isNotification(message)) {
    notifications.push(message);
  }
};

const readLoop = async (
  transport: AppServerTransport,
  pending: Map<string, PendingRequest>,
  notifications: ReturnType<typeof createPushQueue<CodexAppServerNotification>>,
  serverRequests: ReturnType<typeof createPushQueue<AppServerRequest>>,
) => {
  let buffered = "";
  for await (const chunk of transport.incoming) {
    buffered += chunk;
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      handleMessage(
        parseLine(line) ?? {},
        pending,
        notifications,
        serverRequests,
      );
    }
  }

  if (buffered.trim().length > 0) {
    handleMessage(
      parseLine(buffered) ?? {},
      pending,
      notifications,
      serverRequests,
    );
  }
};

export const createCodexAppServerRpc = (transport: AppServerTransport) => {
  const pending = new Map<string, PendingRequest>();
  const notifications = createPushQueue<CodexAppServerNotification>();
  const serverRequests = createPushQueue<AppServerRequest>();
  let nextId = 1;

  const reader = readLoop(transport, pending, notifications, serverRequests)
    .catch((err) => {
      const error = err instanceof Error ? err : new Error(String(err));
      rejectAll(pending, error);
    })
    .finally(() => {
      notifications.end();
      serverRequests.end();
    });

  const request = (method: string, params: unknown) => {
    const id = nextId;
    nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      pending.set(String(id), { resolve, reject });
    });
    return Promise.resolve(writeJsonLine(transport, { id, method, params }))
      .then(() => promise)
      .catch((err) => {
        pending.delete(String(id));
        throw err;
      });
  };

  const notify = (method: string, params?: unknown) =>
    writeJsonLine(
      transport,
      params === undefined ? { method } : { method, params },
    );

  const respond = (id: string | number, result: unknown) =>
    writeJsonLine(transport, { id, result });

  const close = async () => {
    await transport.close?.();
    await reader;
  };

  return {
    request,
    notify,
    respond,
    close,
    notifications: notifications.iterator,
    serverRequests: serverRequests.iterator,
  };
};
