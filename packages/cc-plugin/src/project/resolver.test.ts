/**
 * Resolver tests. Pure HTTP layer — stubs only `globalThis.fetch`. The git
 * detection is now the caller's responsibility (see resolver.ts header for
 * why), so no `mock.module()` is needed here, which keeps `git.test.ts`
 * untouched when both files run in the same `bun test` invocation.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveProjectForPath } from "./resolver";

const SERVER_URL = "http://test.invalid";

let originalFetch: typeof fetch;
let calls: Array<{ url: string; init?: RequestInit }>;
// The resolver attaches authHeaders(), which reads MIMIR_API_KEY and
// ~/.mimir/config.json — isolate both so the developer's real key and
// config never leak into assertions (or test output).
let savedApiKey: string | undefined;
let savedMimirHome: string | undefined;
let mimirHomeDir: string;

beforeEach(async () => {
  originalFetch = globalThis.fetch;
  calls = [];
  savedApiKey = process.env.MIMIR_API_KEY;
  savedMimirHome = process.env.MIMIR_HOME;
  delete process.env.MIMIR_API_KEY;
  mimirHomeDir = await mkdtemp(join(tmpdir(), "mimir-resolver-"));
  process.env.MIMIR_HOME = mimirHomeDir;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (savedApiKey === undefined) delete process.env.MIMIR_API_KEY;
  else process.env.MIMIR_API_KEY = savedApiKey;
  if (savedMimirHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = savedMimirHome;
  await rm(mimirHomeDir, { recursive: true, force: true });
});

const stubFetch = (respond: (url: string, init?: RequestInit) => Response) => {
  globalThis.fetch = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const u = typeof url === "string" ? url : url.toString();
    calls.push({ url: u, init });
    return respond(u, init);
  }) as typeof fetch;
};

const mkProject = (
  overrides?: Partial<{ id: string; git_remote: string | null }>,
) => ({
  id: overrides?.id ?? "uuid-abc",
  title: "test repo",
  description: null,
  git_remote: overrides?.git_remote ?? null,
  local_path: "/tmp/test",
  technologies: [],
  purpose: null,
});

describe("resolveProjectForPath", () => {
  test("returns project when server responds 200 with valid payload", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ project: mkProject() }), { status: 200 }),
    );
    const result = await resolveProjectForPath(SERVER_URL, "/tmp/test", null);
    expect(result?.id).toBe("uuid-abc");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://test.invalid/v1/projects/resolve");
  });

  test("forwards gitRemote into the request body when provided", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            project: mkProject({ git_remote: "git@github.com:org/repo" }),
          }),
          { status: 200 },
        ),
    );
    await resolveProjectForPath(
      SERVER_URL,
      "/tmp/test",
      "git@github.com:org/repo",
    );
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body.gitRemote).toBe("git@github.com:org/repo");
    expect(body.localPath).toBe("/tmp/test");
  });

  test("omits gitRemote from body when null", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ project: mkProject() }), { status: 200 }),
    );
    await resolveProjectForPath(SERVER_URL, "/tmp/test", null);
    const body = JSON.parse(calls[0]?.init?.body as string);
    expect(body.gitRemote).toBeUndefined();
    expect(body.localPath).toBe("/tmp/test");
  });

  test("sends no Authorization header when no key is configured", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ project: mkProject() }), { status: 200 }),
    );
    await resolveProjectForPath(SERVER_URL, "/tmp/test", null);
    const headers = calls[0]?.init?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.Authorization).toBeUndefined();
  });

  test("sends Bearer auth when MIMIR_API_KEY is set (MIM-77 gate)", async () => {
    process.env.MIMIR_API_KEY = "test-key";
    stubFetch(
      () =>
        new Response(JSON.stringify({ project: mkProject() }), { status: 200 }),
    );
    await resolveProjectForPath(SERVER_URL, "/tmp/test", null);
    const headers = calls[0]?.init?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.Authorization).toBe("Bearer test-key");
  });

  test("returns null when fetch throws (network error)", async () => {
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await resolveProjectForPath(SERVER_URL, "/tmp/test", null);
    expect(result).toBeNull();
  });

  test("returns null when server responds non-2xx", async () => {
    stubFetch(() => new Response("server down", { status: 500 }));
    const result = await resolveProjectForPath(SERVER_URL, "/tmp/test", null);
    expect(result).toBeNull();
  });

  test("returns null when payload is missing the project field", async () => {
    stubFetch(
      () => new Response(JSON.stringify({ other: "stuff" }), { status: 200 }),
    );
    const result = await resolveProjectForPath(SERVER_URL, "/tmp/test", null);
    expect(result).toBeNull();
  });

  test("returns null when payload is not valid JSON", async () => {
    stubFetch(() => new Response("not json at all", { status: 200 }));
    const result = await resolveProjectForPath(SERVER_URL, "/tmp/test", null);
    expect(result).toBeNull();
  });
});
