import { beforeEach, describe, expect, mock, test } from "bun:test";
import { jsonSchema, type ModelMessage, tool, type ToolSet } from "ai";
import { Surreal } from "surrealdb";

// -- Mocks for the finalizeTurn threading tests (MIM-74) — must precede the
// module-under-test import so the fire-and-forget trio hits spies, not the DB.
const extractSpy = mock(async () => {});
mock.module("../goldfish/memory", () => ({
  extractAndStoreMemories: extractSpy,
}));

// Background extraction now builds a rootScope(await getDb(), orgId) (MIM-69).
// Hand back an inert (unconnected) Surreal so no real socket opens — the store
// call it wraps is the mocked extractSpy, which never touches the connection.
mock.module("../db/surreal", () => ({ getDb: async () => new Surreal() }));

const updateTokenSpy = mock(async () => ({ needsCompaction: true }));
const appendAssistantSpy = mock(async () => "id-1");
mock.module("./message-log/index", () => ({
  updateTokenCount: updateTokenSpy,
  appendAssistantOutput: appendAssistantSpy,
}));

const runCompactionSpy = mock(async () => {});
mock.module("./compaction", () => ({ runCompaction: runCompactionSpy }));

import { classifyToolCalls, finalizeTurn } from "./post-processing";

const call = (toolName: string) => ({ toolCallId: `id-${toolName}`, toolName });

const stubTool = () =>
  tool({
    description: "stub",
    inputSchema: jsonSchema({ type: "object", properties: {} }),
    execute: async () => "ok",
  });

const serverTools: ToolSet = {
  project_memory_search: stubTool(),
  cartographer_search: stubTool(),
  // Simulates an MCP tool that connected AFTER boot — present in the
  // ToolSet because getServerTools() merges getMcpTools() per request.
  "resolve-library-id": stubTool(),
};

describe("classifyToolCalls", () => {
  test("splits server and client calls by ToolSet membership", () => {
    const { serverCalls, clientCalls } = classifyToolCalls(
      [call("project_memory_search"), call("Read"), call("Edit")],
      serverTools,
    );
    expect(serverCalls.map((c) => c.toolName)).toEqual([
      "project_memory_search",
    ]);
    expect(clientCalls.map((c) => c.toolName)).toEqual(["Read", "Edit"]);
  });

  test("late-connected MCP tools classify as server calls — the refreshToolNames bug", () => {
    const { serverCalls, clientCalls } = classifyToolCalls(
      [call("resolve-library-id")],
      serverTools,
    );
    expect(serverCalls).toHaveLength(1);
    expect(clientCalls).toHaveLength(0);
  });

  test("unknown tools go to the client", () => {
    const { serverCalls, clientCalls } = classifyToolCalls(
      [call("some_editor_tool")],
      serverTools,
    );
    expect(serverCalls).toHaveLength(0);
    expect(clientCalls).toHaveLength(1);
  });

  test("empty ToolSet classifies everything client-side", () => {
    const { clientCalls } = classifyToolCalls([call("anything")], {});
    expect(clientCalls).toHaveLength(1);
  });
});

describe("finalizeTurn BYOK threading (MIM-74)", () => {
  beforeEach(() => {
    extractSpy.mockClear();
    updateTokenSpy.mockClear();
    runCompactionSpy.mockClear();
    appendAssistantSpy.mockClear();
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  const messages: ModelMessage[] = [{ role: "user", content: "tell me things" }];
  const makeCtx = (
    providerOverride: { apiKey: string; smallModel?: string } | null,
  ) => ({
    projectId: "proj-1",
    providerOverride,
    request: { messages, model: "anthropic/claude-test" },
    scope: { orgId: "test-org" },
  });

  test("keyed turn forwards the override to extraction and compaction", async () => {
    const override = { apiKey: "sk-user", smallModel: "anthropic/haiku" };
    finalizeTurn("plenty of assistant text", [], undefined, makeCtx(override), 42);
    await flush();

    // extractAndStoreMemories now takes (scope, messages, projectId, byok).
    expect(extractSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      "proj-1",
      { override, requestModelId: "anthropic/claude-test" },
    );
    // runCompaction now takes (orgId, modelId, override).
    expect(runCompactionSpy).toHaveBeenCalledWith(
      "test-org",
      "anthropic/claude-test",
      override,
    );
  });

  test("keyless turn passes null — env small model path unchanged", async () => {
    finalizeTurn("plenty of assistant text", [], undefined, makeCtx(null), 42);
    await flush();

    expect(extractSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Array),
      "proj-1",
      null,
    );
    expect(runCompactionSpy).toHaveBeenCalledWith(
      "test-org",
      "anthropic/claude-test",
      null,
    );
  });
});
