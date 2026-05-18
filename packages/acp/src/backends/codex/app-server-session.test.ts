import { describe, expect, test } from "bun:test";
import {
  initializeCodexAppServer,
  startCodexAppServerThread,
  startCodexAppServerTurn,
  type CodexAppServerRpcClient,
} from "./app-server-session";

const createFakeRpc = () => {
  const requests: { method: string; params: unknown }[] = [];
  const notifications: { method: string; params?: unknown }[] = [];
  const rpc = {
    request(method: string, params: unknown) {
      requests.push({ method, params });
      return Promise.resolve({});
    },
    notify(method: string, params?: unknown) {
      notifications.push(
        params === undefined ? { method } : { method, params },
      );
      return Promise.resolve();
    },
  } satisfies CodexAppServerRpcClient;

  return { rpc, requests, notifications };
};

describe("Codex app-server session requests", () => {
  test("initializes with experimental notifications enabled", async () => {
    const fake = createFakeRpc();

    await initializeCodexAppServer(fake.rpc);

    expect(fake.requests).toEqual([
      {
        method: "initialize",
        params: {
          clientInfo: {
            name: "mimir-acp",
            title: "Mimir ACP",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: [],
          },
        },
      },
    ]);
    expect(fake.notifications).toEqual([{ method: "initialized" }]);
  });

  test("starts threads with the configured model, cwd, mode, and instruction file", async () => {
    const fake = createFakeRpc();

    await startCodexAppServerThread(fake.rpc, {
      instructionPath: "/tmp/mimir-codex-instructions/session.md",
      serverUrl: "http://mimir.conhost.lan",
      userMemoryDbPath: "/tmp/memories.db",
      workingDirectory: "/Users/rageltd/Projects/mimir",
      model: "gpt-5.5",
      mode: "read-only",
      effort: "high",
    });

    expect(fake.requests).toEqual([
      {
        method: "thread/start",
        params: {
          model: "gpt-5.5",
          cwd: "/Users/rageltd/Projects/mimir",
          approvalPolicy: "on-request",
          sandbox: "read-only",
          config: {
            model_instructions_file:
              "/tmp/mimir-codex-instructions/session.md",
            mcp_servers: {
              "user-memory": {
                command: "bun",
                args: [
                  "/Users/rageltd/Projects/mimir/packages/acp/src/tools/user-memory-mcp.ts",
                ],
                env: { MIMIR_USER_MEMORY_DB: "/tmp/memories.db" },
              },
              mimir: { url: "http://mimir.conhost.lan/mcp" },
              context7: {
                command: "bunx",
                args: ["@upstash/context7-mcp"],
              },
              filesystem: {
                command: "bunx",
                args: [
                  "@modelcontextprotocol/server-filesystem",
                  "/Users/rageltd/Projects/mimir",
                  "/tmp",
                ],
              },
            },
          },
        },
      },
    ]);
  });

  test("starts turns with text input and current model settings", async () => {
    const fake = createFakeRpc();

    await startCodexAppServerTurn(fake.rpc, {
      threadId: "thread_1",
      prompt: "Fix streaming.",
      model: "gpt-5.5",
      effort: "medium",
    });

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
          effort: "medium",
        },
      },
    ]);
  });
});
