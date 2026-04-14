import { test, expect, describe } from "bun:test";
import {
  formatContextForPrompt,
  buildArgs,
  writeMcpConfig,
  iterateNdjson,
} from ".";
import type { CCBackendConfig } from "../../config";

// ── formatContextForPrompt ──

describe("formatContextForPrompt", () => {
  test("formats messages with role labels and XML wrapper", () => {
    const messages = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ];
    const result = formatContextForPrompt(messages);
    expect(result).toContain("<conversation_context>");
    expect(result).toContain("</conversation_context>");
    expect(result).toContain("[User]\nhello");
    expect(result).toContain("[Assistant]\nhi");
  });

  test("returns empty string for empty array", () => {
    expect(formatContextForPrompt([])).toBe("");
  });

  test("preserves multiline content", () => {
    const messages = [
      { role: "user" as const, content: "line one\nline two\nline three" },
    ];
    const result = formatContextForPrompt(messages);
    expect(result).toContain("line one\nline two\nline three");
  });

  test("preserves unicode and special characters", () => {
    const content = 'quotes "here" and émojis 🎉 and <xml> & entities';
    const messages = [{ role: "user" as const, content }];
    const result = formatContextForPrompt(messages);
    expect(result).toContain(content);
  });

  test("handles single message", () => {
    const messages = [{ role: "user" as const, content: "only" }];
    const result = formatContextForPrompt(messages);
    expect(result).toContain("[User]\nonly");
    expect(result).toContain("<conversation_context>");
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
  const mkArgs = (overrides?: {
    contextMessages?: { role: "user" | "assistant"; content: string }[];
    systemPrompt?: string;
    cc?: CCBackendConfig;
    model?: string;
  }) =>
    buildArgs(
      {
        contextMessages: overrides?.contextMessages ?? [
          { role: "user" as const, content: "prev" },
        ],
        systemPrompt: overrides?.systemPrompt ?? "<xml>prompt</xml>",
        cc: overrides?.cc ?? baseCc,
        model: overrides?.model,
      },
      "/tmp/mcp.json",
    );

  test("includes --append-system-prompt when context messages are present", () => {
    const args = mkArgs();
    expect(args).toContain("--append-system-prompt");
    const idx = args.indexOf("--append-system-prompt");
    expect(args[idx + 1]).toContain("<conversation_context>");
  });

  test("omits --append-system-prompt when context is empty", () => {
    const args = mkArgs({ contextMessages: [] });
    expect(args).not.toContain("--append-system-prompt");
  });

  test("always includes --input-format stream-json", () => {
    const args = mkArgs();
    const idx = args.indexOf("--input-format");
    expect(idx).not.toBe(-1);
    expect(args[idx + 1]).toBe("stream-json");
  });

  test("never includes -p flag (prompt goes via stdin)", () => {
    const args = mkArgs();
    expect(args).not.toContain("-p");
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
      {
        contextMessages: [],
        systemPrompt: "s",
        cc: baseCc,
      },
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
      await writeMcpConfig(tmpPath, "http://localhost:3777", "/tmp/test-user-memories.db");
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
      await writeMcpConfig(tmpPath, "http://localhost:3777", "/tmp/test-user-memories.db", [
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
      await writeMcpConfig(tmpPath, "http://localhost:3777", "/tmp/test-user-memories.db", [
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
      await writeMcpConfig(tmpPath, "http://localhost:3777", "/tmp/test-user-memories.db", [
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
});
