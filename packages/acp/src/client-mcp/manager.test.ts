/**
 * Tests for the ClientMcpManager.
 *
 * The transports (stdio/http/sse) are not exercised directly — we replace
 * the MCP SDK's `Client` constructor with a test double and drive the
 * manager through its public surface (getToolDefs, owns, callTool, close).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type * as acp from "@agentclientprotocol/sdk";

// Stub the transport modules so importing the manager doesn't try to
// spawn processes or open HTTP connections at test time.
mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class StubTransport {},
}));
mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: class StubTransport {},
}));
mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: class StubTransport {},
}));

type FakeClient = {
  connect: ReturnType<typeof mock>;
  listTools: ReturnType<typeof mock>;
  callTool: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
};

let fakeClients: FakeClient[] = [];

const makeFake = (): FakeClient => ({
  connect: mock(() => Promise.resolve()),
  listTools: mock(() => Promise.resolve({ tools: [] })),
  callTool: mock(() =>
    Promise.resolve({ content: [{ type: "text", text: "ok" }] }),
  ),
  close: mock(() => Promise.resolve()),
});

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  // The proxy routes each method call to fakeClients[idx] at CALL time,
  // not construction time. That lets tests push fixtures on fakeClients
  // between creating the manager and awaiting its first operation.
  Client: class {
    private readonly idx: number;
    constructor() {
      this.idx = fakeClients.length;
      fakeClients.push(makeFake());
    }
    connect(...args: unknown[]) {
      return fakeClients[this.idx]!.connect(...args);
    }
    listTools(...args: unknown[]) {
      return fakeClients[this.idx]!.listTools(...args);
    }
    callTool(...args: unknown[]) {
      return fakeClients[this.idx]!.callTool(...args);
    }
    close(...args: unknown[]) {
      return fakeClients[this.idx]!.close(...args);
    }
  },
}));

import { createClientMcpManager } from "./manager";

const mkStdioServer = (name: string): acp.McpServer => ({
  name,
  command: "/usr/bin/true",
  args: [],
  env: [],
});

describe("ClientMcpManager", () => {
  beforeEach(() => {
    fakeClients = [];
  });

  test("no servers -> no tool defs, owns returns false", async () => {
    const mgr = createClientMcpManager("s1", []);
    const defs = await mgr.getToolDefs();
    expect(defs).toEqual([]);
    expect(mgr.owns("mcp__whatever__x")).toBe(false);
    await mgr.close();
  });

  test("undefined servers arg is treated as empty list", async () => {
    const mgr = createClientMcpManager("s1", undefined);
    expect(await mgr.getToolDefs()).toEqual([]);
  });

  test("full enumeration flow — tools from two servers namespaced correctly", async () => {
    // Build a manager, then after the Client constructors have run, we
    // override listTools to return fixture data. Because ensureInit is
    // lazy (runs on first getToolDefs()), we need to trigger it and
    // the mock override in the right order.
    const mgr = createClientMcpManager("s1", [
      mkStdioServer("zed"),
      mkStdioServer("db"),
    ]);

    // Kick off init. The Client constructors run synchronously inside
    // initOne(); by the time the first `await client.connect(...)` runs,
    // fakeClients is populated.
    const initTick = mgr.getToolDefs();

    // Let microtask queue drain so connect() is queued but not yet returned.
    await Promise.resolve();

    expect(fakeClients.length).toBe(2);
    fakeClients[0]!.listTools = mock(() =>
      Promise.resolve({
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
          {
            name: "write_file",
            description: "Write a file",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    );
    fakeClients[1]!.listTools = mock(() =>
      Promise.resolve({
        tools: [
          {
            name: "query",
            description: "Run a query",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    );

    const defs = await initTick;

    const names = defs.map((d) => d.function.name).sort();
    expect(names).toEqual([
      "mcp__db__query",
      "mcp__zed__read_file",
      "mcp__zed__write_file",
    ]);

    expect(mgr.owns("mcp__zed__read_file")).toBe(true);
    expect(mgr.owns("mcp__db__query")).toBe(true);
    expect(mgr.owns("mcp__zed__unknown")).toBe(false);
    expect(mgr.owns("mcp__missing__x")).toBe(false);
    expect(mgr.owns("read_file")).toBe(false); // not namespaced
  });

  test("callTool strips namespace and forwards to the right client", async () => {
    const mgr = createClientMcpManager("s1", [mkStdioServer("zed")]);
    const initTick = mgr.getToolDefs();
    await Promise.resolve();
    expect(fakeClients.length).toBe(1);
    fakeClients[0]!.listTools = mock(() =>
      Promise.resolve({
        tools: [
          {
            name: "read_file",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    );
    fakeClients[0]!.callTool = mock((params: { name: string }) =>
      Promise.resolve({
        content: [{ type: "text", text: `called:${params.name}` }],
      }),
    );
    await initTick;

    const result = await mgr.callTool("mcp__zed__read_file", { path: "/x" });

    expect(result).toBe("called:read_file");
    expect(fakeClients[0]!.callTool).toHaveBeenCalledWith({
      name: "read_file",
      arguments: { path: "/x" },
    });
  });

  test("callTool returns string error when underlying call rejects", async () => {
    const mgr = createClientMcpManager("s1", [mkStdioServer("zed")]);
    const initTick = mgr.getToolDefs();
    await Promise.resolve();
    fakeClients[0]!.listTools = mock(() =>
      Promise.resolve({
        tools: [
          { name: "boom", inputSchema: { type: "object", properties: {} } },
        ],
      }),
    );
    fakeClients[0]!.callTool = mock(() =>
      Promise.reject(new Error("nope")),
    );
    await initTick;

    const result = await mgr.callTool("mcp__zed__boom", {});
    expect(result).toContain("Error calling mcp__zed__boom");
    expect(result).toContain("nope");
  });

  test("callTool on unknown tool rejects with descriptive error", async () => {
    const mgr = createClientMcpManager("s1", []);
    const err = await mgr
      .callTool("mcp__nothing__x", {})
      .then(() => null)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain("not a client MCP tool");
  });

  test("connection failure on one server doesn't poison the others", async () => {
    const mgr = createClientMcpManager("s1", [
      mkStdioServer("bad"),
      mkStdioServer("good"),
    ]);
    const initTick = mgr.getToolDefs();
    await Promise.resolve();
    expect(fakeClients.length).toBe(2);
    fakeClients[0]!.connect = mock(() => Promise.reject(new Error("boom")));
    fakeClients[1]!.listTools = mock(() =>
      Promise.resolve({
        tools: [
          { name: "ok", inputSchema: { type: "object", properties: {} } },
        ],
      }),
    );
    const defs = await initTick;

    // Only the good one contributed tools
    expect(defs.map((d) => d.function.name)).toEqual(["mcp__good__ok"]);
    expect(mgr.owns("mcp__good__ok")).toBe(true);
    expect(mgr.owns("mcp__bad__anything")).toBe(false);
  });

  test("isError result is surfaced as an error string", async () => {
    const mgr = createClientMcpManager("s1", [mkStdioServer("zed")]);
    const initTick = mgr.getToolDefs();
    await Promise.resolve();
    fakeClients[0]!.listTools = mock(() =>
      Promise.resolve({
        tools: [
          { name: "oops", inputSchema: { type: "object", properties: {} } },
        ],
      }),
    );
    fakeClients[0]!.callTool = mock(() =>
      Promise.resolve({
        isError: true,
        content: [{ type: "text", text: "boom message" }],
      }),
    );
    await initTick;

    const result = await mgr.callTool("mcp__zed__oops", {});
    expect(result).toContain("Error from tool");
    expect(result).toContain("boom message");
  });

  test("close calls close on each connected client", async () => {
    const mgr = createClientMcpManager("s1", [
      mkStdioServer("a"),
      mkStdioServer("b"),
    ]);
    const initTick = mgr.getToolDefs();
    await Promise.resolve();
    expect(fakeClients.length).toBe(2);
    await initTick;

    await mgr.close();

    expect(fakeClients[0]!.close).toHaveBeenCalledTimes(1);
    expect(fakeClients[1]!.close).toHaveBeenCalledTimes(1);
  });

  test("getToolDefs is idempotent — second call does not reconnect", async () => {
    const mgr = createClientMcpManager("s1", [mkStdioServer("zed")]);
    const initTick = mgr.getToolDefs();
    await Promise.resolve();
    fakeClients[0]!.listTools = mock(() =>
      Promise.resolve({
        tools: [
          { name: "t", inputSchema: { type: "object", properties: {} } },
        ],
      }),
    );
    await initTick;

    const clientCountAfterFirst = fakeClients.length;
    await mgr.getToolDefs();
    await mgr.getToolDefs();
    expect(fakeClients.length).toBe(clientCountAfterFirst);
    expect(fakeClients[0]!.connect).toHaveBeenCalledTimes(1);
  });
});
