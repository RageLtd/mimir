import { describe, expect, test } from "bun:test";
import type { RequestToolPermission } from "../types";
import { createAppServerApprovalHandler } from "./app-server-approvals";
import type { AppServerRequest } from "./app-server-rpc";

const commandRequest = (command = "ls"): AppServerRequest => ({
  id: "req-1",
  method: "item/commandExecution/requestApproval",
  params: {
    threadId: "t1",
    turnId: "turn1",
    itemId: "cmd_1",
    startedAtMs: Date.now(),
    command,
  },
});

const fileChangeRequest = (): AppServerRequest => ({
  id: "req-2",
  method: "item/fileChange/requestApproval",
  params: {
    threadId: "t1",
    turnId: "turn1",
    itemId: "file_1",
    startedAtMs: Date.now(),
    reason: "needs write access",
  },
});

const v1ExecRequest = (): AppServerRequest => ({
  id: "req-3",
  method: "execCommandApproval",
  params: {
    conversationId: "t1",
    callId: "call_1",
    approvalId: null,
    command: ["bun", "test"],
    cwd: "/tmp",
    reason: null,
    parsedCmd: [],
  },
});

describe("Codex app-server approvals", () => {
  test("auto-approve mode accepts command requests", async () => {
    const handler = createAppServerApprovalHandler(undefined, true);
    const result = await handler.handleRequest(commandRequest());
    expect(result).toEqual({ decision: "accept" });
  });

  test("auto-approve mode accepts file change requests", async () => {
    const handler = createAppServerApprovalHandler(undefined, true);
    const result = await handler.handleRequest(fileChangeRequest());
    expect(result).toEqual({ decision: "accept" });
  });

  test("auto-approve mode uses v1 decision for exec approval", async () => {
    const handler = createAppServerApprovalHandler(undefined, true);
    const result = await handler.handleRequest(v1ExecRequest());
    expect(result).toEqual({ decision: "approved" });
  });

  test("bridges command approval to RequestToolPermission when allowed", async () => {
    const permission: RequestToolPermission = async () => ({
      allowed: true,
      permanent: false,
    });
    const handler = createAppServerApprovalHandler(permission, false);
    const result = await handler.handleRequest(commandRequest("bun test"));
    expect(result).toEqual({ decision: "accept" });
  });

  test("bridges command approval to RequestToolPermission when denied", async () => {
    const permission: RequestToolPermission = async () => ({
      allowed: false,
      message: "user denied",
    });
    const handler = createAppServerApprovalHandler(permission, false);
    const result = await handler.handleRequest(commandRequest("rm -rf /"));
    expect(result).toEqual({ decision: "decline" });
  });

  test("permanent allow maps to acceptForSession for v2 methods", async () => {
    const permission: RequestToolPermission = async () => ({
      allowed: true,
      permanent: true,
    });
    const handler = createAppServerApprovalHandler(permission, false);
    const result = await handler.handleRequest(commandRequest());
    expect(result).toEqual({ decision: "acceptForSession" });
  });

  test("permanent allow maps to approved_for_session for v1 methods", async () => {
    const permission: RequestToolPermission = async () => ({
      allowed: true,
      permanent: true,
    });
    const handler = createAppServerApprovalHandler(permission, false);
    const result = await handler.handleRequest(v1ExecRequest());
    expect(result).toEqual({ decision: "approved_for_session" });
  });

  test("declines unsupported dynamic tool calls", async () => {
    const handler = createAppServerApprovalHandler(undefined, false);
    const request: AppServerRequest = {
      id: "req-4",
      method: "item/tool/call",
      params: {
        threadId: "t1",
        turnId: "turn1",
        callId: "call_1",
        namespace: null,
        tool: "custom_tool",
        arguments: {},
      },
    };
    const result = await handler.handleRequest(request);
    expect(result).toEqual({ contentItems: [], success: false });
  });

  test("falls back to auto-approve when no permission callback provided", async () => {
    const handler = createAppServerApprovalHandler(undefined, false);
    const result = await handler.handleRequest(commandRequest());
    expect(result).toEqual({ decision: "accept" });
  });
});
