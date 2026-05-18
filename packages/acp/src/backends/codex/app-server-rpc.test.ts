import { describe, expect, test } from "bun:test";
import { createPushQueue } from "../../utils/push-queue";
import { createCodexAppServerRpc } from "./app-server-rpc";

const createFakeTransport = () => {
  const incoming = createPushQueue<string>();
  const writes: string[] = [];

  return {
    incoming,
    writes,
    transport: {
      incoming: incoming.iterator,
      write(data: string) {
        writes.push(data);
      },
      close() {
        incoming.end();
      },
    },
  };
};

describe("Codex app-server JSON-RPC client", () => {
  test("writes requests as JSON lines and resolves matching responses", async () => {
    const fake = createFakeTransport();
    const rpc = createCodexAppServerRpc(fake.transport);
    const response = rpc.request("initialize", {
      clientInfo: { name: "mimir-acp" },
    });

    expect(fake.writes).toEqual([
      '{"id":1,"method":"initialize","params":{"clientInfo":{"name":"mimir-acp"}}}\n',
    ]);

    fake.incoming.push('{"id":1,"result":{"userAgent":"codex/0.130.0"}}\n');

    await expect(response).resolves.toEqual({ userAgent: "codex/0.130.0" });
    await rpc.close();
  });

  test("writes notifications without ids", async () => {
    const fake = createFakeTransport();
    const rpc = createCodexAppServerRpc(fake.transport);

    await rpc.notify("initialized");

    expect(fake.writes).toEqual(['{"method":"initialized"}\n']);
    await rpc.close();
  });

  test("streams app-server notifications", async () => {
    const fake = createFakeTransport();
    const rpc = createCodexAppServerRpc(fake.transport);
    const next = rpc.notifications.next();

    fake.incoming.push(
      '{"method":"item/agentMessage/delta","params":{"threadId":"thread_1","turnId":"turn_1","itemId":"msg_1","delta":"Hello"}}\n',
    );

    await expect(next).resolves.toEqual({
      value: {
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread_1",
          turnId: "turn_1",
          itemId: "msg_1",
          delta: "Hello",
        },
      },
      done: false,
    });
    await rpc.close();
  });

  test("handles partial JSON lines", async () => {
    const fake = createFakeTransport();
    const rpc = createCodexAppServerRpc(fake.transport);
    const response = rpc.request("thread/start", { model: "gpt-5.5" });

    fake.incoming.push('{"id":');
    fake.incoming.push('1,"result":{"thread":{"id":"thread_1"}}}\n');

    await expect(response).resolves.toEqual({ thread: { id: "thread_1" } });
    await rpc.close();
  });

  test("rejects matching requests on JSON-RPC errors", async () => {
    const fake = createFakeTransport();
    const rpc = createCodexAppServerRpc(fake.transport);
    const response = rpc.request("turn/start", { threadId: "thread_1" });

    fake.incoming.push(
      '{"id":1,"error":{"code":-32603,"message":"turn failed"}}\n',
    );

    await expect(response).rejects.toThrow("turn failed");
    await rpc.close();
  });

  test("routes server-initiated requests to serverRequests queue", async () => {
    const fake = createFakeTransport();
    const rpc = createCodexAppServerRpc(fake.transport);
    const next = rpc.serverRequests.next();

    fake.incoming.push(
      '{"id":"req-1","method":"item/commandExecution/requestApproval","params":{"threadId":"t1","turnId":"turn1","itemId":"cmd_1","startedAtMs":1000,"command":"rm -rf /"}}\n',
    );

    const result = await next;
    expect(result.done).toBe(false);
    expect(result.value).toEqual({
      id: "req-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: "t1",
        turnId: "turn1",
        itemId: "cmd_1",
        startedAtMs: 1000,
        command: "rm -rf /",
      },
    });
    await rpc.close();
  });

  test("respond sends JSON-RPC result back to server", async () => {
    const fake = createFakeTransport();
    const rpc = createCodexAppServerRpc(fake.transport);

    rpc.respond("req-1", { decision: "accept" });

    expect(fake.writes).toEqual([
      '{"id":"req-1","result":{"decision":"accept"}}\n',
    ]);
    await rpc.close();
  });
});
