/**
 * CUDA-variant acquisition: a CUDA suffix pulls two archives — the server
 * build and the companion `cudart-*` runtime bundle — and both land flat in
 * the embedder dir. Hermetic via MIMIR_HOME temp dirs and a local stub
 * server; real tar.gz fixtures because the archive layout is the contract.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { $ } from "bun";
import { embedderBinaryPath, embedderDir } from "./embedder";
import { installLlamaServer } from "./embedder-install";
import { LLAMA_CPP_RELEASE } from "./embedder-platform";

setDefaultTimeout(30_000);

let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.MIMIR_HOME;
  process.env.MIMIR_HOME = mkdtempSync(join(tmpdir(), "mimir-cuda-test-"));
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = savedHome;
});

const silent = () => {};

const CUDA_SUFFIX = "ubuntu-cuda-13.4-x64";
const CUDA_LIBS = ["libcudart.so.13", "libcublas.so.13", "libcublasLt.so.13"];

/** Real tar.gz with the release layout: `<top>/{files}`. */
const buildArchive = async (top: string, files: Record<string, string>) => {
  const stage = mkdtempSync(join(tmpdir(), "mimir-archive-fixture-"));
  const inner = join(stage, top);
  await mkdir(inner, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    await Bun.write(join(inner, name), body);
  }
  const archive = join(stage, "fixture.tar.gz");
  await $`tar -czf ${archive} -C ${stage} ${top}`.quiet();
  return new Uint8Array(await Bun.file(archive).arrayBuffer());
};

const serverArchive = () =>
  buildArchive(`llama-${LLAMA_CPP_RELEASE.tag}`, {
    "llama-server": "#!/bin/sh\necho fake\n",
    "libggml.so": "fake-lib",
  });

const cudartArchive = (libs: readonly string[]) =>
  buildArchive(
    `cudart-llama-${LLAMA_CPP_RELEASE.tag}-bin-${CUDA_SUFFIX}`,
    Object.fromEntries(libs.map((lib) => [lib, `fake ${lib}`])),
  );

/** Serve several archives by path and count hits per path. */
const withArchiveServer = async (
  archives: Record<string, Uint8Array>,
  fn: (
    url: (path: string) => string,
    hits: () => Record<string, number>,
  ) => Promise<void>,
) => {
  const hits: Record<string, number> = {};
  const server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const { pathname } = new URL(req.url);
      const bytes = archives[pathname];
      if (!bytes) return new Response("not found", { status: 404 });
      hits[pathname] = (hits[pathname] ?? 0) + 1;
      return new Response(bytes);
    },
  });
  await fn(
    (path) => `http://127.0.0.1:${server.port}${path}`,
    () => hits,
  ).finally(() => server.stop(true));
};

describe("installLlamaServer (CUDA variants)", () => {
  test("installs the runtime libraries beside the binary and skips when current", async () => {
    const archives = {
      "/server.tgz": await serverArchive(),
      "/cudart.tgz": await cudartArchive(CUDA_LIBS),
    };
    await withArchiveServer(archives, async (url, hits) => {
      const [err, binary] = await installLlamaServer(silent, {
        url: url("/server.tgz"),
        runtimeUrl: url("/cudart.tgz"),
        assetSuffix: CUDA_SUFFIX,
      });
      expect(err).toBeNull();
      expect(binary).toBe(embedderBinaryPath());
      for (const lib of CUDA_LIBS) {
        expect(await Bun.file(join(embedderDir(), lib)).exists()).toBe(true);
      }
      expect(hits()).toEqual({ "/server.tgz": 1, "/cudart.tgz": 1 });

      // Marker covers tag + variant → neither archive is fetched again.
      await installLlamaServer(silent, {
        url: url("/server.tgz"),
        runtimeUrl: url("/cudart.tgz"),
        assetSuffix: CUDA_SUFFIX,
      });
      expect(hits()).toEqual({ "/server.tgz": 1, "/cudart.tgz": 1 });
    });
  });

  test("a runtime archive without libraries errors loudly", async () => {
    const archives = {
      "/server.tgz": await serverArchive(),
      "/cudart.tgz": await cudartArchive([]),
    };
    await withArchiveServer(archives, async (url) => {
      const [err] = await installLlamaServer(silent, {
        url: url("/server.tgz"),
        runtimeUrl: url("/cudart.tgz"),
        assetSuffix: CUDA_SUFFIX,
      });
      expect(err?.message).toContain("contained no libraries");
    });
  });

  test("non-CUDA variants never fetch a runtime bundle", async () => {
    const archives = { "/server.tgz": await serverArchive() };
    await withArchiveServer(archives, async (url, hits) => {
      const [err] = await installLlamaServer(silent, {
        url: url("/server.tgz"),
        assetSuffix: "ubuntu-vulkan-x64",
      });
      expect(err).toBeNull();
      expect(hits()).toEqual({ "/server.tgz": 1 });
    });
  });
});
