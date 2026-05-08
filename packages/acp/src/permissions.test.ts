import { test, expect, describe, mock } from "bun:test";
import { createRequestToolPermission } from "./permissions";

const baseRequest = {
  toolName: "Bash",
  input: { command: "rm -rf /tmp/foo" },
  toolCallId: "tc_123",
  title: "Run shell command",
};

const mockConn = (outcome: { outcome: string; optionId?: string }) => {
  const fn = mock(async (_params: unknown) => ({ outcome }));
  return { requestPermission: fn };
};

describe("createRequestToolPermission", () => {
  test("sends correct ACP request shape", async () => {
    const conn = mockConn({ outcome: "selected", optionId: "allow_once" });
    const requestPermission = createRequestToolPermission(
      conn as never,
      "session_abc",
    );

    await requestPermission(baseRequest);

    expect(conn.requestPermission).toHaveBeenCalledTimes(1);
    const call = conn.requestPermission.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(call.sessionId).toBe("session_abc");
    const toolCall = call.toolCall as Record<string, unknown>;
    expect(toolCall.toolCallId).toBe("tc_123");
    expect(toolCall.title).toBe("Run shell command");
    expect(toolCall.rawInput).toEqual({ command: "rm -rf /tmp/foo" });
    expect(toolCall.kind).toBe("execute");
    const options = call.options as { kind: string }[];
    expect(options).toHaveLength(3);
    expect(options.map((o) => o.kind)).toEqual([
      "allow_once",
      "allow_always",
      "reject_once",
    ]);
  });

  test("uses toolName as title fallback", async () => {
    const conn = mockConn({ outcome: "selected", optionId: "allow_once" });
    const requestPermission = createRequestToolPermission(
      conn as never,
      "s1",
    );

    await requestPermission({ ...baseRequest, title: undefined });

    const call = conn.requestPermission.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    const toolCall = call.toolCall as Record<string, unknown>;
    expect(toolCall.title).toBe("Bash");
  });

  test("allow_once → allowed, not permanent", async () => {
    const conn = mockConn({ outcome: "selected", optionId: "allow_once" });
    const requestPermission = createRequestToolPermission(
      conn as never,
      "s1",
    );

    const result = await requestPermission(baseRequest);

    expect(result.allowed).toBe(true);
    expect(result.permanent).toBe(false);
  });

  test("allow_always → allowed, permanent", async () => {
    const conn = mockConn({ outcome: "selected", optionId: "allow_always" });
    const requestPermission = createRequestToolPermission(
      conn as never,
      "s1",
    );

    const result = await requestPermission(baseRequest);

    expect(result.allowed).toBe(true);
    expect(result.permanent).toBe(true);
  });

  test("reject_once → denied with message", async () => {
    const conn = mockConn({ outcome: "selected", optionId: "reject_once" });
    const requestPermission = createRequestToolPermission(
      conn as never,
      "s1",
    );

    const result = await requestPermission(baseRequest);

    expect(result.allowed).toBe(false);
    expect(result.message).toBe("Permission denied by user");
  });

  test("cancelled → denied", async () => {
    const conn = mockConn({ outcome: "cancelled" });
    const requestPermission = createRequestToolPermission(
      conn as never,
      "s1",
    );

    const result = await requestPermission(baseRequest);

    expect(result.allowed).toBe(false);
    expect(result.message).toBe("Permission request cancelled");
  });

  test("unknown optionId → denied", async () => {
    const conn = mockConn({
      outcome: "selected",
      optionId: "something_unknown",
    });
    const requestPermission = createRequestToolPermission(
      conn as never,
      "s1",
    );

    const result = await requestPermission(baseRequest);

    expect(result.allowed).toBe(false);
    expect(result.message).toBe("Permission denied by user");
  });
});
