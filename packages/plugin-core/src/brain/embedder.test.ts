/**
 * Embedder unit tests — everything testable without a real llama-server:
 * config/paths, the /health probe contract, the /v1/embeddings client
 * (ordering, dimension guard, error degradation), and the not-installed
 * path. The real-binary leg is the MIM-85 live smoke, not a unit test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEmbedQuery,
  EMBEDDER_MODEL,
  embedderBaseUrl,
  embedderDir,
  embedderInstalled,
  embedderModelPath,
  embedderPort,
  embedTexts,
  getOrStartEmbedder,
} from "./embedder";

// Env isolation (MIM-74 lesson: save/restore so a developer's real env
// can't bend assertions).
const SAVED_KEYS = ["MIMIR_EMBEDDER_PORT", "MIMIR_HOME"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of SAVED_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Hermetic home: embedderInstalled() must see an empty dir, never the
  // developer's real ~/.mimir.
  process.env.MIMIR_HOME = mkdtempSync(join(tmpdir(), "mimir-embedder-test-"));
});

afterEach(() => {
  for (const key of SAVED_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const DIMS = EMBEDDER_MODEL.dimensions;
const vectorOf = (fill: number, dims: number = DIMS) =>
  new Array(dims).fill(fill);

/** Stub llama-server: healthy /health plus a configurable embeddings leg. */
const withStub = async (
  embeddings: (body: { input: string[] }) => Response | Promise<Response>,
  fn: (port: number) => Promise<void>,
) => {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/health") {
        return Response.json({ status: "ok" });
      }
      if (url.pathname === "/v1/embeddings") {
        return embeddings((await req.json()) as { input: string[] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("stub server did not bind a port");
  process.env.MIMIR_EMBEDDER_PORT = String(port);
  await fn(port).finally(() => server.stop(true));
};

const okEmbeddings = (vectors: number[][]) =>
  Response.json({
    data: vectors.map((embedding, index) => ({ embedding, index })),
  });

describe("config and paths", () => {
  test("port defaults, honors env, rejects garbage", () => {
    expect(embedderPort()).toBe(46337);
    process.env.MIMIR_EMBEDDER_PORT = "5555";
    expect(embedderPort()).toBe(5555);
    expect(embedderBaseUrl()).toBe("http://127.0.0.1:5555");
    process.env.MIMIR_EMBEDDER_PORT = "not-a-port";
    expect(embedderPort()).toBe(46337);
  });

  test("artifact paths live under MIMIR_HOME/embedder", () => {
    const home = process.env.MIMIR_HOME as string;
    expect(embedderDir()).toBe(join(home, "embedder"));
    expect(embedderModelPath()).toBe(
      join(home, "embedder", EMBEDDER_MODEL.file),
    );
  });

  test("not installed in an empty home", async () => {
    expect(await embedderInstalled()).toBe(false);
  });
});

describe("getOrStartEmbedder", () => {
  test("returns base URL when a healthy server is already up", async () => {
    await withStub(
      () => okEmbeddings([]),
      async (port) => {
        expect(await getOrStartEmbedder()).toBe(`http://127.0.0.1:${port}`);
      },
    );
  });

  test("null when nothing is running and nothing is installed", async () => {
    process.env.MIMIR_EMBEDDER_PORT = "45991"; // nothing listens here
    expect(await getOrStartEmbedder()).toBeNull();
  });
});

describe("embedTexts", () => {
  test("empty input short-circuits without a server", async () => {
    process.env.MIMIR_EMBEDDER_PORT = "45991";
    expect(await embedTexts([])).toEqual([]);
  });

  test("returns vectors re-ordered by index", async () => {
    await withStub(
      () =>
        // Deliberately out of order — client must sort by index.
        Response.json({
          data: [
            { embedding: vectorOf(2), index: 1 },
            { embedding: vectorOf(1), index: 0 },
          ],
        }),
      async () => {
        const result = await embedTexts(["first", "second"]);
        expect(result).not.toBeNull();
        expect(result?.[0]?.[0]).toBe(1);
        expect(result?.[1]?.[0]).toBe(2);
      },
    );
  });

  test("dimension mismatch degrades to null (one-vector-space guard)", async () => {
    await withStub(
      () => okEmbeddings([vectorOf(1, 64)]),
      async () => {
        expect(await embedTexts(["text"])).toBeNull();
      },
    );
  });

  test("count mismatch degrades to null", async () => {
    await withStub(
      () => okEmbeddings([vectorOf(1)]),
      async () => {
        expect(await embedTexts(["a", "b"])).toBeNull();
      },
    );
  });

  test("HTTP error degrades to null", async () => {
    await withStub(
      () => new Response("boom", { status: 500 }),
      async () => {
        expect(await embedTexts(["text"])).toBeNull();
      },
    );
  });
});

describe("createEmbedQuery", () => {
  test("embeds a single query via the seam shape", async () => {
    await withStub(
      () => okEmbeddings([vectorOf(0.5)]),
      async () => {
        const embedQuery = createEmbedQuery();
        const vector = await embedQuery("what changed in auth?");
        expect(vector).toHaveLength(DIMS);
        expect(vector?.[0]).toBe(0.5);
      },
    );
  });

  test("null when the embedder is unreachable", async () => {
    process.env.MIMIR_EMBEDDER_PORT = "45991";
    const embedQuery = createEmbedQuery();
    expect(await embedQuery("anything")).toBeNull();
  });
});
