import { test, expect, describe } from "bun:test";
import {
  buildNdjson,
  SYNTHETIC_SESSION_ID,
  buildArgs,
  writeMcpConfig,
  iterateNdjson,
} from "./claude-code";
import type { CCBackendConfig } from "../config";

// ── buildNdjson ──

describe("buildNdjson", () => {
  test("produces valid NDJSON with one line per message", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ];
    const ndjson = buildNdjson(messages);
    const lines = ndjson.trimEnd().split("\n");
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  test("ends with a trailing newline", () => {
    const ndjson = buildNdjson([{ role: "user" as const, content: "test" }]);
    expect(ndjson.endsWith("\n")).toBe(true);
  });

  test("wraps each message in SDK envelope format", () => {
    const messages = [
      { role: "user" as const, content: "question" },
      { role: "assistant" as const, content: "answer" },
    ];
    const lines = buildNdjson(messages)
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(lines[0]).toEqual({
      type: "user",
      session_id: SYNTHETIC_SESSION_ID,
      message: {
        role: "user",
        content: [{ type: "text", text: "question" }],
      },
    });

    expect(lines[1]).toEqual({
      type: "assistant",
      session_id: SYNTHETIC_SESSION_ID,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
      },
    });
  });

  test("uses Anthropic API content block format (array of text blocks)", () => {
    const ndjson = buildNdjson([
      { role: "user" as const, content: "test message" },
    ]);
    const parsed = JSON.parse(ndjson.trimEnd());
    const content = parsed.message.content;

    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(1);
    expect(content[0]).toEqual({ type: "text", text: "test message" });
  });

  test("type field matches the message role", () => {
    const messages = [
      { role: "user" as const, content: "u" },
      { role: "assistant" as const, content: "a" },
      { role: "user" as const, content: "u2" },
    ];
    const lines = buildNdjson(messages)
      .trimEnd()
      .split("\n")
      .map((l) => JSON.parse(l));

    expect(lines[0].type).toBe("user");
    expect(lines[1].type).toBe("assistant");
    expect(lines[2].type).toBe("user");
  });

  test("handles empty array", () => {
    const ndjson = buildNdjson([]);
    expect(ndjson).toBe("\n");
  });

  test("preserves multiline content", () => {
    const content = "line one\nline two\nline three";
    const ndjson = buildNdjson([{ role: "user" as const, content }]);
    const parsed = JSON.parse(ndjson.trimEnd());
    expect(parsed.message.content[0].text).toBe(content);
  });

  test("preserves unicode and special characters", () => {
    const content = 'quotes "here" and émojis 🎉 and <xml> & entities';
    const ndjson = buildNdjson([{ role: "user" as const, content }]);
    const parsed = JSON.parse(ndjson.trimEnd());
    expect(parsed.message.content[0].text).toBe(content);
  });

  test("each line is self-contained valid JSON (no cross-line dependencies)", () => {
    const messages = [
      { role: "user" as const, content: "a" },
      { role: "assistant" as const, content: "b" },
      { role: "user" as const, content: "c" },
    ];
    const lines = buildNdjson(messages).trimEnd().split("\n");
    // Parse each independently
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].message.content[0].text).toBe("a");
    expect(parsed[1].message.content[0].text).toBe("b");
    expect(parsed[2].message.content[0].text).toBe("c");
  });
});

// ── buildArgs ──

const baseCc: CCBackendConfig = {
  enabled: true,
  mcpConfigPath: "./mcp.json",
  disallowedTools: [],
  permissionMode: "bypassPermissions",
  models: {},
};

describe("buildArgs", () => {
  const mkArgs = (overrides?: { prompt?: string; history?: { role: "user" | "assistant"; content: string }[]; systemPrompt?: string; cc?: CCBackendConfig; model?: string }) =>
    buildArgs(
      {
        prompt: overrides?.prompt ?? "hello",
        history: overrides?.history ?? [{ role: "user" as const, content: "prev" }],
        systemPrompt: overrides?.systemPrompt ?? "<xml>prompt</xml>",
        cc: overrides?.cc ?? baseCc,
        model: overrides?.model,
      },
      "/tmp/mcp.json",
    );

  test("includes --input-format stream-json when history is present", () => {
    const args = mkArgs();
    const idx = args.indexOf("--input-format");
    expect(idx).not.toBe(-1);
    expect(args[idx + 1]).toBe("stream-json");
  });

  test("omits --input-format when history is empty", () => {
    const args = mkArgs({ history: [] });
    expect(args.indexOf("--input-format")).toBe(-1);
  });

  test("passes prompt to -p", () => {
    const args = mkArgs({ prompt: "my question" });
    const idx = args.indexOf("-p");
    expect(idx).not.toBe(-1);
    expect(args[idx + 1]).toBe("my question");
  });

  test("passes system prompt to --system-prompt", () => {
    const xml = "<rules>Be direct.</rules>";
    const args = mkArgs({ systemPrompt: xml });
    const idx = args.indexOf("--system-prompt");
    expect(idx).not.toBe(-1);
    expect(args[idx + 1]).toBe(xml);
  });

  test("passes mcpConfigPath to --mcp-config", () => {
    const args = buildArgs(
      { prompt: "q", history: [], systemPrompt: "s", cc: baseCc },
      "/tmp/custom-mcp.json",
    );
    const idx = args.indexOf("--mcp-config");
    expect(idx).not.toBe(-1);
    expect(args[idx + 1]).toBe("/tmp/custom-mcp.json");
  });

  test("includes --disallowedTools when configured", () => {
    const cc = { ...baseCc, disallowedTools: ["Agent", "Monitor"] };
    const args = mkArgs({ cc });
    const idx = args.indexOf("--disallowedTools");
    expect(idx).not.toBe(-1);
    expect(args[idx + 1]).toBe("Agent,Monitor");
  });

  test("omits --disallowedTools when list is empty", () => {
    const args = mkArgs();
    expect(args).not.toContain("--disallowedTools");
  });

  test("includes --model when provided", () => {
    const args = mkArgs({ model: "opus" });
    const idx = args.indexOf("--model");
    expect(idx).not.toBe(-1);
    expect(args[idx + 1]).toBe("opus");
  });

  test("omits --model when not provided", () => {
    const args = mkArgs();
    expect(args).not.toContain("--model");
  });

  test("always includes --output-format stream-json", () => {
    const args = mkArgs();
    const idx = args.indexOf("--output-format");
    expect(idx).not.toBe(-1);
    expect(args[idx + 1]).toBe("stream-json");
  });

  test("always includes --no-session-persistence", () => {
    const args = mkArgs();
    expect(args).toContain("--no-session-persistence");
  });

  test("passes permission mode from cc config", () => {
    const cc = { ...baseCc, permissionMode: "plan" };
    const args = mkArgs({ cc });
    const idx = args.indexOf("--permission-mode");
    expect(idx).not.toBe(-1);
    expect(args[idx + 1]).toBe("plan");
  });
});

// ── writeMcpConfig ──

describe("writeMcpConfig", () => {
  test("writes valid JSON with mimir and context7 servers", async () => {
    const tmpPath = `/tmp/mimir-test-mcp-${Date.now()}.json`;
    try {
      await writeMcpConfig(tmpPath, "http://localhost:3777");
      const content = JSON.parse(await Bun.file(tmpPath).text());

      expect(content.mcpServers.mimir).toEqual({
        type: "http",
        url: "http://localhost:3777/mcp",
      });
      expect(content.mcpServers.context7).toEqual({
        type: "stdio",
        command: "bunx",
        args: ["@upstash/context7-mcp"],
      });
    } finally {
      await Bun.$`rm -f ${tmpPath}`.quiet();
    }
  });

  test("merges client stdio MCP servers", async () => {
    const tmpPath = `/tmp/mimir-test-mcp-${Date.now()}.json`;
    try {
      await writeMcpConfig(tmpPath, "http://localhost:3777", [
        {
          name: "custom",
          command: "node",
          args: ["server.js"],
          env: [{ name: "PORT", value: "8080" }],
        },
      ]);
      const content = JSON.parse(await Bun.file(tmpPath).text());

      expect(content.mcpServers.custom).toEqual({
        type: "stdio",
        command: "node",
        args: ["server.js"],
        env: { PORT: "8080" },
      });
      // mimir's servers still present
      expect(content.mcpServers.mimir).toBeDefined();
      expect(content.mcpServers.context7).toBeDefined();
    } finally {
      await Bun.$`rm -f ${tmpPath}`.quiet();
    }
  });

  test("mimir's servers win on name collision", async () => {
    const tmpPath = `/tmp/mimir-test-mcp-${Date.now()}.json`;
    try {
      await writeMcpConfig(tmpPath, "http://localhost:3777", [
        {
          name: "mimir",
          command: "fake",
          args: [],
          env: [],
        },
      ]);
      const content = JSON.parse(await Bun.file(tmpPath).text());

      // mimir's own entry should override the client's
      expect(content.mcpServers.mimir.type).toBe("http");
      expect(content.mcpServers.mimir.url).toBe("http://localhost:3777/mcp");
    } finally {
      await Bun.$`rm -f ${tmpPath}`.quiet();
    }
  });

  test("merges client SSE MCP servers", async () => {
    const tmpPath = `/tmp/mimir-test-mcp-${Date.now()}.json`;
    try {
      await writeMcpConfig(tmpPath, "http://localhost:3777", [
        {
          name: "remote",
          type: "sse",
          url: "http://example.com/mcp",
          headers: [{ name: "Authorization", value: "Bearer tok" }],
        },
      ]);
      const content = JSON.parse(await Bun.file(tmpPath).text());

      expect(content.mcpServers.remote).toEqual({
        type: "sse",
        url: "http://example.com/mcp",
        headers: { Authorization: "Bearer tok" },
      });
    } finally {
      await Bun.$`rm -f ${tmpPath}`.quiet();
    }
  });
});

// ── iterateNdjson ──

const toStream = (text: string): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

const collectNdjson = async (stream: ReadableStream<Uint8Array>) => {
  const results: unknown[] = [];
  for await (const obj of iterateNdjson(stream)) {
    results.push(obj);
  }
  return results;
};

describe("iterateNdjson", () => {
  test("parses multiple JSON lines", async () => {
    const stream = toStream('{"a":1}\n{"b":2}\n');
    const results = await collectNdjson(stream);
    expect(results).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("handles trailing content without final newline", async () => {
    const stream = toStream('{"a":1}\n{"b":2}');
    const results = await collectNdjson(stream);
    expect(results).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("skips non-JSON lines", async () => {
    const stream = toStream('{"a":1}\nnot json\n{"b":2}\n');
    const results = await collectNdjson(stream);
    expect(results).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("skips blank lines", async () => {
    const stream = toStream('{"a":1}\n\n\n{"b":2}\n');
    const results = await collectNdjson(stream);
    expect(results).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("handles empty stream", async () => {
    const stream = toStream("");
    const results = await collectNdjson(stream);
    expect(results).toEqual([]);
  });

  test("handles chunked delivery across line boundaries", async () => {
    // Simulate data arriving in chunks that split across JSON lines
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('{"a":'));
        controller.enqueue(encoder.encode('1}\n{"b":'));
        controller.enqueue(encoder.encode("2}\n"));
        controller.close();
      },
    });
    const results = await collectNdjson(stream);
    expect(results).toEqual([{ a: 1 }, { b: 2 }]);
  });

  test("roundtrips with buildNdjson", async () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi there" },
      { role: "user" as const, content: "follow up" },
    ];
    const ndjson = buildNdjson(messages);
    const stream = toStream(ndjson);
    const parsed = await collectNdjson(stream);

    expect(parsed).toHaveLength(3);
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;
      const obj = parsed[i] as { type: string; message: { content: Array<{ text: string }> } };
      expect(obj.type).toBe(msg.role);
      expect(obj.message.content[0]!.text).toBe(msg.content);
    }
  });
});
