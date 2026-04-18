/**
 * Project resolver tests.
 *
 * Uses Bun's `mock.module()` to stub `./git` so the resolver never shells
 * out during tests. `globalThis.fetch` is replaced per test — restored in
 * afterEach. No production code is modified to fit the test harness.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Per-test knob for the detector stub. mock.module() captures this
// reference, so each test can set `nextRemote` before exercising the
// resolver and the stub picks up the latest value.
let nextRemote: string | null = null;

mock.module("./git", () => ({
  detectGitRemote: async () => nextRemote,
}));

// Must import AFTER mock.module() registers the stub.
const { resolveProjectForPath } = await import("./resolver");

const CFG = { serverUrl: "http://test.invalid", apiKey: "test-key" };

let originalFetch: typeof fetch;
let calls: Array<{ url: string; init?: RequestInit }>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  calls = [];
  nextRemote = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const stubFetch = (respond: (url: string, init?: RequestInit) => Response) => {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === "string" ? url : url.toString();
    calls.push({ url: u, init });
    return respond(u, init);
  }) as typeof fetch;
};

const mkProject = (overrides?: Partial<{ id: string; git_remote: string | null }>) => ({
  id: overrides?.id ?? "abc123",
  title: "test repo",
  description: null,
  git_remote: overrides?.git_remote ?? null,
  local_path: "/tmp/test",
  technologies: [],
  purpose: null,
});

describe("resolveProjectForPath", () => {
  test("returns project when server responds 200 with valid payload", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ project: mkProject() }), { status: 200 }),
    );
    const result = await resolveProjectForPath(CFG, "/tmp/test");
    expect(result?.id).toBe("abc123");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://test.invalid/v1/projects/resolve");
  });

  test("forwards detected git remote into the request body", async () => {
    nextRemote = "git@github.com:org/repo";
    stubFetch(() =>
      new Response(
        JSON.stringify({
          project: mkProject({ git_remote: "git@github.com:org/repo" }),
        }),
        { status: 200 },
      ),
    );
    await resolveProjectForPath(CFG, "/tmp/test");
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body.gitRemote).toBe("git@github.com:org/repo");
    expect(body.localPath).toBe("/tmp/test");
  });

  test("omits gitRemote from body when detector returns null", async () => {
    nextRemote = null;
    stubFetch(() =>
      new Response(JSON.stringify({ project: mkProject() }), { status: 200 }),
    );
    await resolveProjectForPath(CFG, "/tmp/test");
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body.gitRemote).toBeUndefined();
    expect(body.localPath).toBe("/tmp/test");
  });

  test("sends authorization header when apiKey is set", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ project: mkProject() }), { status: 200 }),
    );
    await resolveProjectForPath(CFG, "/tmp/test");
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe("Bearer test-key");
  });

  test("omits authorization header when apiKey is empty", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ project: mkProject() }), { status: 200 }),
    );
    await resolveProjectForPath({ ...CFG, apiKey: "" }, "/tmp/test");
    const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  test("returns null when fetch throws (network error)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await resolveProjectForPath(CFG, "/tmp/test");
    expect(result).toBeNull();
  });

  test("returns null when server responds non-2xx", async () => {
    stubFetch(() => new Response("server down", { status: 500 }));
    const result = await resolveProjectForPath(CFG, "/tmp/test");
    expect(result).toBeNull();
  });

  test("returns null when payload is missing project field", async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ other: "stuff" }), { status: 200 }),
    );
    const result = await resolveProjectForPath(CFG, "/tmp/test");
    expect(result).toBeNull();
  });

  test("returns null when payload is not valid JSON", async () => {
    stubFetch(() => new Response("not json at all", { status: 200 }));
    const result = await resolveProjectForPath(CFG, "/tmp/test");
    expect(result).toBeNull();
  });
});
