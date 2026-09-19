import { describe, expect, test } from "bun:test";
import {
  enabledMcpServers,
  mergeMcpServers,
  parseMcpJson,
  parseMcpServers,
} from "./config-file";

describe("parseMcpServers", () => {
  test("accepts stdio and remote shapes", () => {
    const { servers, errors } = parseMcpServers({
      local: {
        command: "mimir-cc",
        args: ["user-memory-mcp"],
        env: { A: "1" },
      },
      remote: {
        type: "http",
        url: "https://x",
        headers: { Authorization: "b" },
      },
    });
    expect(errors).toEqual([]);
    expect(servers).toEqual({
      local: {
        command: "mimir-cc",
        args: ["user-memory-mcp"],
        env: { A: "1" },
      },
      remote: {
        type: "http",
        url: "https://x",
        headers: { Authorization: "b" },
      },
    });
  });

  test("enabled: false becomes a tombstone", () => {
    expect(parseMcpServers({ gone: { enabled: false } }).servers).toEqual({
      gone: null,
    });
  });

  test("reports invalid entries by name and keeps the rest", () => {
    const { servers, errors } = parseMcpServers({
      ok: { command: "x" },
      nocmd: {},
      badargs: { command: "x", args: "nope" },
      badenv: { command: "x", env: { A: 1 } },
      nourl: { type: "http" },
      legacy: { type: "sse", url: "u" },
      scalar: 3,
    });
    expect(Object.keys(servers)).toEqual(["ok"]);
    expect(errors).toEqual([
      "nocmd: stdio server needs a command",
      "badargs: args must be a string array",
      "badenv: env must be a string map",
      "nourl: http server needs a url",
      "legacy: unknown type sse",
      "scalar: expected a table",
    ]);
  });

  test("absent table is empty; non-table is an error", () => {
    expect(parseMcpServers(undefined)).toEqual({ servers: {}, errors: [] });
    expect(parseMcpServers([]).errors).toEqual([
      "mcpServers: expected a table",
    ]);
  });
});

describe("parseMcpJson", () => {
  test("reads the mcpServers key", () => {
    expect(
      parseMcpJson('{"mcpServers":{"a":{"command":"x"}}}').servers,
    ).toEqual({
      a: { command: "x" },
    });
  });

  test("malformed JSON is an error, not a throw", () => {
    expect(parseMcpJson("{").errors[0]).toStartWith("invalid JSON");
    expect(parseMcpJson("[]").errors).toEqual(["expected a JSON object"]);
  });
});

describe("merge and finalize", () => {
  test("deeper layer wins per name and tombstones remove", () => {
    const merged = mergeMcpServers(
      { a: { command: "old" }, b: { command: "b" } },
      { a: { command: "new" }, b: null },
    );
    expect(merged).toEqual({ a: { command: "new" }, b: null });
    expect(enabledMcpServers(merged)).toEqual({ a: { command: "new" } });
  });
});
