import type { BackendEvent } from "../types";
import type { AppServerApprovalHandler } from "./app-server-approvals";
import {
  type CodexAppServerNotification,
  createCodexAppServerEventTranslator,
} from "./app-server-events";
import type { AppServerRequest } from "./app-server-rpc";
import {
  type CodexAppServerRpcClient,
  startCodexAppServerTurn,
} from "./app-server-session";
import type { RunCodexOptions } from "./formatting";

export type CodexAppServerSession = {
  readonly rpc: CodexAppServerRpcClient & {
    readonly notifications: AsyncIterable<CodexAppServerNotification>;
    readonly serverRequests: AsyncIterable<AppServerRequest>;
    readonly respond: (id: string | number, result: unknown) => void;
  };
  readonly threadId: string;
  readonly approvalHandler: AppServerApprovalHandler;
};

const notificationThreadId = (notification: CodexAppServerNotification) => {
  if ("threadId" in notification.params) return notification.params.threadId;
  if (notification.method === "thread/started") {
    return notification.params.thread.id;
  }
  return undefined;
};

const startApprovalLoop = (session: CodexAppServerSession) => {
  const loop = async () => {
    for await (const request of session.rpc.serverRequests) {
      const result = await session.approvalHandler
        .handleRequest(request)
        .catch(() => ({}));
      session.rpc.respond(request.id, result);
    }
  };
  // Fire-and-forget — loop ends when the serverRequests queue ends
  loop().catch(() => {});
};

export const runCodexAppServerTurn = async function* (
  session: CodexAppServerSession,
  options: Pick<RunCodexOptions, "prompt" | "model" | "effort" | "signal">,
) {
  const translate = createCodexAppServerEventTranslator();
  startApprovalLoop(session);

  // Fire turn/start without awaiting the response — the protocol streams
  // notifications immediately and the response may arrive only after the
  // turn completes. Blocking here would buffer all deltas until the response
  // landed, causing "no output until next prompt."
  let turnStartFailed: string | null = null;
  startCodexAppServerTurn(session.rpc, {
    threadId: session.threadId,
    prompt: options.prompt,
    model: options.model,
    effort: options.effort,
  }).catch((err) => {
    turnStartFailed =
      err instanceof Error ? err.message : "turn/start request failed";
  });

  for await (const notification of session.rpc.notifications) {
    if (options.signal?.aborted) {
      yield { type: "finish", stopReason: "cancelled" } satisfies BackendEvent;
      return;
    }

    if (turnStartFailed) {
      yield { type: "error", error: turnStartFailed } satisfies BackendEvent;
      yield {
        type: "finish",
        stopReason: "failed",
        errors: [turnStartFailed],
      } satisfies BackendEvent;
      return;
    }

    const threadId = notificationThreadId(notification);
    if (threadId !== undefined && threadId !== session.threadId) continue;

    for (const event of translate(notification)) {
      yield event;
      if (event.type === "finish") return;
    }
  }
};
