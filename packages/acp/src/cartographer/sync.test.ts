import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildIndexPayload, syncIndex } from "./sync";

let originalFetch: typeof fetch;
let requests: Array<{ url: string; init?: RequestInit }>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  requests = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const stubFetch = (response: Response) => {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: url.toString(), init });
    return response;
  }) as typeof fetch;
};

const logger = {
  info: () => {},
  error: () => {},
  warn: () => {},
  debug: () => {},
};

const parsedFile = {
  file_path: "/repo/src/index.ts",
  language: "typescript",
  imports: [
    {
      target: "/repo/src/util.ts",
      specifier: "./util",
      symbols: ["helper"],
    },
  ],
  symbols: [
    {
      name: "run",
      kind: "function",
      signature: "export function run()",
      docComment: null,
      visibility: "exported",
      line: 3,
    },
    {
      name: "internal",
      kind: "const",
      signature: "const internal = true",
      docComment: null,
      visibility: "private",
      line: 7,
    },
  ],
};

describe("buildIndexPayload", () => {
  test("converts parse-only file output to the server sync payload", async () => {
    const payload = await buildIndexPayload(
      "/repo",
      [parsedFile],
      "project-123",
    );

    expect(payload.rootPath).toBe("/repo");
    expect(payload.projectId).toBe("project-123");
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0]?.path).toBe("/repo/src/index.ts");
    expect(payload.files[0]?.imports).toEqual([
      { target: "/repo/src/util.ts", specifier: "./util" },
    ]);
    expect(payload.files[0]?.exports).toEqual(["run"]);
    expect(payload.files[0]?.symbols).toEqual([
      { kind: "function", name: "run", line: 3, column: 0 },
      { kind: "const", name: "internal", line: 7, column: 0 },
    ]);
    // /repo/src/index.ts doesn't exist on disk in the test env — hash
    // falls back to empty string, which is the documented contract.
    expect(payload.files[0]?.content_hash).toBe("");
    expect(payload.stats.totalFiles).toBe(1);
    expect(payload.stats.totalSymbols).toBe(2);
    expect(payload.stats.languages).toEqual({ typescript: 1 });
  });
});

describe("syncIndex", () => {
  test("posts generated payload to the cartographer sync endpoint", async () => {
    stubFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await syncIndex(
      {
        serverUrl: "http://mimir.test",
        apiKey: "test-key",
        logger,
      },
      "/repo",
      [parsedFile],
      "project-123",
    );

    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://mimir.test/v1/cartographer/sync");
    expect(requests[0]?.init?.headers).toEqual({
      "Content-Type": "application/json",
      Authorization: "Bearer test-key",
    });

    const body = JSON.parse(requests[0]?.init?.body as string);
    expect(body.rootPath).toBe("/repo");
    expect(body.projectId).toBe("project-123");
    expect(body.files[0].path).toBe("/repo/src/index.ts");
  });
});
