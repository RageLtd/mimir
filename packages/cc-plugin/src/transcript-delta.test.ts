/**
 * Tests for the CC transcript delta pipeline.
 *
 * Focuses on the pure-data path: JSONL → filter → coalesce → ModelMessage[].
 * Watermark round-trip uses a temp file. shipDelta is exercised by stubbing
 * globalThis.fetch — keeps the test hermetic without an HTTP mock library.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  readDelta,
  readWatermark,
  shipDelta,
  writeWatermark,
} from "./transcript-delta";

// Each test gets a fresh temp dir + transcript path. We set MIMIR_HOME
// (NOT HOME) because Bun caches `homedir()` at process start and the
// usual HOME-swap trick silently writes to the developer's real
// ~/.mimir/persist-state. The util.mimirHome() helper honours
// MIMIR_HOME first specifically so tests can isolate state.
let tmp = "";
const originalMimirHome = process.env.MIMIR_HOME;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mimir-td-"));
  process.env.MIMIR_HOME = tmp;
});

afterEach(async () => {
  if (originalMimirHome === undefined) {
    delete process.env.MIMIR_HOME;
  } else {
    process.env.MIMIR_HOME = originalMimirHome;
  }
  await rm(tmp, { recursive: true, force: true });
});

const writeJsonl = async (path: string, entries: readonly unknown[]) => {
  const text = entries.map((e) => JSON.stringify(e)).join("\n");
  await Bun.write(path, text);
};

describe("watermark", () => {
  test("returns 0 for unknown session", async () => {
    const offset = await readWatermark("never-written");
    expect(offset).toBe(0);
  });

  test("round-trips an offset", async () => {
    await writeWatermark("sess-1", 42);
    expect(await readWatermark("sess-1")).toBe(42);
  });

  test("ignores corrupt state file and returns 0", async () => {
    const sessionId = "sess-bad";
    // Stage a corrupt state file. MIMIR_HOME = tmp, so the production
    // code resolves persist-state to ${tmp}/persist-state (no extra
    // `.mimir` segment — that's part of the default homedir-based
    // resolution, not the MIMIR_HOME override).
    const path = join(tmp, "persist-state", `${sessionId}.json`);
    await Bun.write(path, "{not valid json");
    expect(await readWatermark(sessionId)).toBe(0);
  });
});

describe("readDelta filtering", () => {
  test("drops attachments, snapshots, system events, and meta entries", async () => {
    const path = join(tmp, "transcript.jsonl");
    await writeJsonl(path, [
      { type: "last-prompt", lastPrompt: "ignore" },
      { type: "permission-mode", permissionMode: "default" },
      { type: "ai-title", aiTitle: "..." },
      { type: "file-history-snapshot", snapshot: {} },
      { type: "attachment", attachment: {} },
      { type: "system", subtype: "local_command", content: "" },
      {
        type: "user",
        isMeta: true,
        message: { role: "user", content: "should be dropped" },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: "<local-command-stdout>noise</local-command-stdout>",
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: "<command-name>/slash</command-name>",
        },
      },
    ]);

    const { messages, newOffset } = await readDelta(path, 0);
    expect(messages).toEqual([]);
    expect(newOffset).toBe(9);
  });

  test("extracts a real user message", async () => {
    const path = join(tmp, "transcript.jsonl");
    await writeJsonl(path, [
      {
        type: "user",
        message: { role: "user", content: "What does foo do?" },
        uuid: "u1",
      },
    ]);

    const { messages, newOffset } = await readDelta(path, 0);
    expect(messages).toEqual([{ role: "user", content: "What does foo do?" }]);
    expect(newOffset).toBe(1);
  });
});

describe("readDelta coalescing", () => {
  test("merges streaming chunks with the same message.id into one assistant message", async () => {
    const path = join(tmp, "transcript.jsonl");
    const sharedId = "msg_streaming_123";
    await writeJsonl(path, [
      {
        type: "assistant",
        message: {
          role: "assistant",
          id: sharedId,
          content: [{ type: "thinking", thinking: "deliberating..." }],
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          id: sharedId,
          content: [
            {
              type: "tool_use",
              id: "tu_1",
              name: "Bash",
              input: { command: "ls" },
            },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          id: sharedId,
          content: [{ type: "text", text: "Here is the listing." }],
        },
      },
    ]);

    const { messages } = await readDelta(path, 0);
    expect(messages).toHaveLength(1);
    const msg = messages[0]!;
    expect(msg.role).toBe("assistant");
    expect(Array.isArray(msg.content)).toBe(true);
    const parts = msg.content as Array<{ type: string }>;
    // Thinking blocks stripped (decided in plan); tool_use + text preserved.
    expect(parts.map((p) => p.type)).toEqual(["tool-call", "text"]);
  });

  test("converts tool_result user entries to role:tool with proper ToolResultPart", async () => {
    const path = join(tmp, "transcript.jsonl");
    await writeJsonl(path, [
      {
        type: "assistant",
        message: {
          role: "assistant",
          id: "msg_a1",
          content: [
            {
              type: "tool_use",
              id: "tu_42",
              name: "Read",
              input: { file_path: "/x.ts" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_42",
              content: "file contents here",
              is_error: false,
            },
          ],
        },
      },
    ]);

    const { messages } = await readDelta(path, 0);
    expect(messages).toHaveLength(2);
    const toolMsg = messages[1]!;
    expect(toolMsg.role).toBe("tool");
    const parts = toolMsg.content as Array<{
      type: string;
      toolCallId: string;
      toolName: string;
      output: { type: string; value: string };
    }>;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.toolCallId).toBe("tu_42");
    expect(parts[0]!.toolName).toBe("Read");
    expect(parts[0]!.output.value).toBe("file contents here");
  });

  test("respects the watermark and only returns new entries", async () => {
    const path = join(tmp, "transcript.jsonl");
    await writeJsonl(path, [
      { type: "user", message: { role: "user", content: "first" }, uuid: "u1" },
      {
        type: "user",
        message: { role: "user", content: "second" },
        uuid: "u2",
      },
      { type: "user", message: { role: "user", content: "third" }, uuid: "u3" },
    ]);

    const { messages, newOffset } = await readDelta(path, 2);
    expect(messages).toEqual([{ role: "user", content: "third" }]);
    expect(newOffset).toBe(3);
  });
});

describe("shipDelta", () => {
  const originalFetch = globalThis.fetch;
  const BYOK_ENV_VARS = [
    "MIMIR_PROVIDER_API_KEY",
    "MIMIR_PROVIDER",
    "MIMIR_SMALL_MODEL",
  ] as const;
  const savedByokEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Isolate from the developer's real BYOK env (MIM-74)
    for (const name of BYOK_ENV_VARS) {
      savedByokEnv[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const name of BYOK_ENV_VARS) {
      const saved = savedByokEnv[name];
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  });

  test("returns ok with no-op for empty messages", async () => {
    const result = await shipDelta("http://stub", [], "proj");
    expect(result).toEqual({ ok: true, appended: 0 });
  });

  test("POSTs to /v1/messages/persist with the expected body", async () => {
    let capturedUrl = "";
    let capturedBody: unknown = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return new Response(JSON.stringify({ appended: 1, ids: ["x"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await shipDelta(
      "http://server:3000",
      [{ role: "user", content: "hi" }],
      "/repo",
    );
    expect(result).toEqual({ ok: true, appended: 1 });
    expect(capturedUrl).toBe("http://server:3000/v1/messages/persist");
    expect(capturedBody).toEqual({
      messages: [{ role: "user", content: "hi" }],
      project: "/repo",
    });
  });

  test("sends BYOK key header + body hints when configured (MIM-74)", async () => {
    process.env.MIMIR_PROVIDER_API_KEY = "sk-prov";
    process.env.MIMIR_PROVIDER = "anthropic";
    process.env.MIMIR_SMALL_MODEL = "anthropic/haiku";

    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      return new Response(JSON.stringify({ appended: 1, ids: ["x"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    const result = await shipDelta(
      "http://server:3000",
      [{ role: "user", content: "hi" }],
      "/repo",
    );
    expect(result).toEqual({ ok: true, appended: 1 });
    // Key rides the header, never the body
    expect(capturedHeaders["X-Provider-Api-Key"]).toBe("sk-prov");
    expect(JSON.stringify(capturedBody)).not.toContain("sk-prov");
    // Non-secret hints ride the body
    expect(capturedBody.provider).toBe("anthropic");
    expect(capturedBody.small_model).toBe("anthropic/haiku");
  });

  test("no BYOK config → no key header, no body hints", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
      capturedBody = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      return new Response(JSON.stringify({ appended: 1, ids: ["x"] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;

    await shipDelta(
      "http://server:3000",
      [{ role: "user", content: "hi" }],
      "/repo",
    );
    expect(capturedHeaders["X-Provider-Api-Key"]).toBeUndefined();
    expect(capturedBody.provider).toBeUndefined();
    expect(capturedBody.small_model).toBeUndefined();
  });

  test("returns ok:false when the server returns non-200", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", {
        status: 500,
      })) as unknown as typeof globalThis.fetch;

    const result = await shipDelta(
      "http://server:3000",
      [{ role: "user", content: "hi" }],
      "/repo",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("status 500");
  });
});
