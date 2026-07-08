import { describe, expect, test } from "bun:test";
import { jsonSchema, tool, type ToolSet } from "ai";

import { classifyToolCalls } from "./post-processing";

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
