/**
 * Local embedder (MIM-85) — llama-server in embeddings mode, plugin-managed.
 *
 * Satisfies the `EmbedQuery` seam left by MIM-84: hooks and the mimir-local
 * MCP get a query embedder whose text NEVER leaves the machine. Lifecycle is
 * get-or-start per the repo's reuse-processes rule: probe localhost for a
 * healthy server, spawn one if the pinned artifacts are installed, and
 * degrade to null (FTS-only retrieval) otherwise — an absent embedder is a
 * working state, not an error state.
 *
 * The artifact spec below is the ORG VECTOR SPACE contract: different quants
 * of the same model emit close-but-not-identical vectors, so the exact GGUF
 * (pinned by sha256, verified at download time by the installer) plus the
 * pooling config is what keeps every member's vectors comparable. Changing
 * any field of EMBEDDER_MODEL invalidates existing vectors — re-run the
 * backfill after bumping it.
 *
 * llama-server contract (verified against tools/server/README.md):
 *   GET  /health         → 200 {"status":"ok"} ready, 503 while loading
 *   POST /v1/embeddings  → OpenAI shape; requires pooling ≠ none; output is
 *                          Euclidean-normalized (harmless — cosine is
 *                          scale-invariant, parity with the server path).
 */

import { join } from "node:path";
import { attempt } from "../result";
import { mimirHome } from "../util";

// ── Pinned artifact spec (one artifact, one vector space) ──

export const EMBEDDER_MODEL = {
  /** Official Qwen GGUF repo. */
  repo: "Qwen/Qwen3-Embedding-0.6B-GGUF",
  file: "Qwen3-Embedding-0.6B-Q8_0.gguf",
  url: "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf",
  /** LFS oid of the Q8_0 artifact — installer refuses a mismatch. */
  sha256: "06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439",
  bytes: 639_150_592,
  /** Must match the replica's vector space AND the server's EMBED_DIMENSIONS. */
  dimensions: 1024,
  /** qwen3-embedding requires last-token pooling. */
  pooling: "last",
} as const;

const DEFAULT_PORT = 46337;
const EMBEDDER_DIRNAME = "embedder";
const BINARY_FILENAME = "llama-server";
const LOCALHOST = "127.0.0.1";
/** Docs-recommended batch sizing for embedding servers (`-ub 8192`) — with
 *  pooling, each input must fit in a single physical batch, and memory-sized
 *  texts run to a few thousand tokens. */
const BATCH_SIZE = "8192";
const HEALTH_TIMEOUT_MS = 1_500;
const EMBED_TIMEOUT_MS = 30_000;
/** Patient default — backfill and other batch callers ride out a cold
 *  model load. */
const SPAWN_WAIT_MS = 60_000;
/** Query-path default — hooks and interactive MCP calls must not blow
 *  their timeouts waiting on a cold load. The spawn still fires; this
 *  turn degrades to FTS-only and the next turn finds a warm server. */
const QUERY_SPAWN_WAIT_MS = 5_000;
const SPAWN_POLL_INTERVAL_MS = 300;

export const embedderPort = () => {
  const fromEnv = Number.parseInt(process.env.MIMIR_EMBEDDER_PORT ?? "", 10);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_PORT;
};

export const embedderBaseUrl = () => `http://${LOCALHOST}:${embedderPort()}`;

export const embedderDir = () => join(mimirHome(), EMBEDDER_DIRNAME);
export const embedderModelPath = () => join(embedderDir(), EMBEDDER_MODEL.file);
export const embedderBinaryPath = () => join(embedderDir(), BINARY_FILENAME);

const logErr = (msg: string) => {
  process.stderr.write(`[mimir-embedder] ${msg}\n`);
};

// ── Lifecycle: get-or-start ──

const probeHealthy = async (baseUrl: string) => {
  const [err, res] = await attempt(() =>
    fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    }),
  );
  return err === null && res.ok;
};

/** Both pinned artifacts present on disk. Hash verification happens at
 *  download (installer) — re-hashing 640MB per hook invocation is not on. */
export const embedderInstalled = async () =>
  (await Bun.file(embedderModelPath()).exists()) &&
  (await Bun.file(embedderBinaryPath()).exists());

const spawnEmbedder = () => {
  const proc = Bun.spawn(
    [
      embedderBinaryPath(),
      "-m",
      embedderModelPath(),
      "--embedding",
      "--pooling",
      EMBEDDER_MODEL.pooling,
      "--host",
      LOCALHOST,
      "--port",
      String(embedderPort()),
      "-c",
      BATCH_SIZE,
      "-b",
      BATCH_SIZE,
      "-ub",
      BATCH_SIZE,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  // The server outlives the (often hook-lifetime) process that started it;
  // per reuse-processes, nobody stops it — the next caller reuses it.
  proc.unref();
};

const waitHealthy = async (baseUrl: string, timeoutMs: number) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeHealthy(baseUrl)) return true;
    await Bun.sleep(SPAWN_POLL_INTERVAL_MS);
  }
  return false;
};

/**
 * Healthy embedder base URL, starting one if needed. Null means "no vector
 * leg this turn": not installed, or spawn never came healthy. A lost spawn
 * race (port already bound by a sibling hook's spawn) self-resolves — the
 * loser's process exits, waitHealthy sees the winner.
 */
export const getOrStartEmbedder = async (
  opts: { readonly spawnWaitMs?: number } = {},
) => {
  const spawnWaitMs = opts.spawnWaitMs ?? SPAWN_WAIT_MS;
  const baseUrl = embedderBaseUrl();
  if (await probeHealthy(baseUrl)) return baseUrl;
  if (!(await embedderInstalled())) {
    logErr(
      "not installed — run `mimir-cc update` to fetch the model + binary; retrieval degrades to text-only",
    );
    return null;
  }
  spawnEmbedder();
  if (await waitHealthy(baseUrl, spawnWaitMs)) return baseUrl;
  logErr(
    `spawned llama-server but /health never came ok within ${spawnWaitMs}ms`,
  );
  return null;
};

// ── Client ──

/** OpenAI /v1/embeddings response — serialisation boundary. */
type EmbeddingsResponse = {
  data: { embedding: number[]; index: number }[];
};

/**
 * Embed a batch. Null on any failure (callers degrade to FTS-only); the
 * why goes to stderr. Output order matches input order.
 */
export const embedTexts = async (
  texts: readonly string[],
  opts: { readonly spawnWaitMs?: number } = {},
) => {
  if (texts.length === 0) return [];
  const baseUrl = await getOrStartEmbedder(opts);
  if (baseUrl === null) return null;

  const [err, vectors] = await attempt(async () => {
    const res = await fetch(`${baseUrl}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: texts, model: EMBEDDER_MODEL.file }),
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      throw new Error(`HTTP ${res.status}: ${detail}`);
    }
    const body = (await res.json()) as EmbeddingsResponse;
    const ordered = [...body.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
    if (ordered.length !== texts.length) {
      throw new Error(
        `asked for ${texts.length} embeddings, got ${ordered.length}`,
      );
    }
    for (const v of ordered) {
      // One-vector-space guard: a wrong-dimension vector means a wrong
      // model is answering on our port — poisoning the replica is worse
      // than degrading.
      if (v.length !== EMBEDDER_MODEL.dimensions) {
        throw new Error(
          `dimension mismatch: got ${v.length}, pinned ${EMBEDDER_MODEL.dimensions}`,
        );
      }
    }
    return ordered;
  });

  if (err) {
    logErr(`embed failed: ${err.message}`);
    return null;
  }
  return vectors;
};

/** The `EmbedQuery` seam implementation — plug into retrieve/tools/hooks.
 *  Inferred shape matches `EmbedQuery`; call sites typed against the seam
 *  verify the fit where it matters. Query-path spawn wait by default. */
export const createEmbedQuery = () => async (text: string) => {
  const vectors = await embedTexts([text], {
    spawnWaitMs: QUERY_SPAWN_WAIT_MS,
  });
  return vectors?.[0] ?? null;
};
