import { describe, expect, test } from "bun:test";
import { createPushQueue } from "../../utils/push-queue";
import type { BackendEvent } from "../types";
import type { AppServerApprovalHandler } from "./app-server-approvals";
import type { CodexAppServerNotification } from "./app-server-events";
import type { AppServerRequest } from "./app-server-rpc";
import { runCodexAppServerTurn } from "./app-server-runner";

const noopApprovalHandler: AppServerApprovalHandler = {
  handleRequest: () => Promise.resolve({}),
};

const createSession = () => {
  const notifications = createPushQueue<CodexAppServerNotification>();
  const serverRequests = createPushQueue<AppServerRequest>();
  const requests: { method: string; params: unknown }[] = [];
  const responses: { id: string | number; result: unknown }[] = [];
  const session = {
    threadId: "thread_1",
    approvalHandler: noopApprovalHandler,
    rpc: {
      notifications: notifications.iterator,
      serverRequests: serverRequests.iterator,
      request(method: string, params: unknown) {
        requests.push({ method, params });
        return Promise.resolve({});
      },
      notify() {
        return Promise.resolve();
      },
      respond(id: string | number, result: unknown) {
        responses.push({ id, result });
      },
    },
  };

  return { session, notifications, serverRequests, requests, responses };
};

describe("Codex app-server runner", () => {
  test("starts a turn and yields streaming BackendEvents until turn completion", async () => {
    const fake = createSession();
    const output: BackendEvent[] = [];
    const run = async () => {
      for await (const event of runCodexAppServerTurn(fake.session, {
        prompt: "Fix streaming.",
        model: "gpt-5.5",
        effort: "high",
      })) {
        output.push(event);
      }
    };

    const running = run();

    fake.notifications.push({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "msg_1",
        delta: "Hello",
      },
    });
    fake.notifications.push({
      method: "turn/completed",
      params: {
        threadId: "thread_1",
        turn: { id: "turn_1", error: null },
      },
    });

    await running;

    expect(fake.requests).toEqual([
      {
        method: "turn/start",
        params: {
          threadId: "thread_1",
          input: [
            {
              type: "text",
              text: "Fix streaming.",
              text_elements: [],
            },
          ],
          model: "gpt-5.5",
          effort: "high",
        },
      },
    ]);
    expect(output).toEqual([
      { type: "text", text: "Hello" },
      {
        type: "finish",
        promptTokens: 0,
        completionTokens: 0,
        contextWindow: undefined,
      },
    ]);
  });

  test("ignores notifications for other threads", async () => {
    const fake = createSession();
    const output: BackendEvent[] = [];
    const running = (async () => {
      for await (const event of runCodexAppServerTurn(fake.session, {
        prompt: "Fix streaming.",
        model: "gpt-5.5",
        effort: "high",
      })) {
        output.push(event);
      }
    })();

    fake.notifications.push({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread_other",
        turnId: "turn_1",
        itemId: "msg_1",
        delta: "Wrong",
      },
    });
    fake.notifications.push({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread_1",
        turnId: "turn_1",
        itemId: "msg_1",
        delta: "Right",
      },
    });
    fake.notifications.push({
      method: "turn/completed",
      params: {
        threadId: "thread_1",
        turn: { id: "turn_1", error: null },
      },
    });

    await running;

    expect(output).toEqual([
      { type: "text", text: "Right" },
      {
        type: "finish",
        promptTokens: 0,
        completionTokens: 0,
        contextWindow: undefined,
      },
    ]);
  });
});
