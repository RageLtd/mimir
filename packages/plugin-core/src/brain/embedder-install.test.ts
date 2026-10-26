/**
 * Acquisition tests — hermetic via MIMIR_HOME temp dirs, a local stub
 * server standing in for HF/GitHub, and a real tar.gz fixture (real tar,
 * real extraction — the archive-layout assumptions are the thing worth
 * testing). The pinned-hash happy path for the REAL 640MB GGUF is the live
 * install's job, not a unit test's.
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
import { embedderBinaryPath, embedderDir, embedderModelPath } from "./embedder";
import {
  installEmbedderModel,
  installLlamaServer,
  sha256File,
} from "./embedder-install";
import { LLAMA_CPP_RELEASE } from "./embedder-platform";

// Stub HTTP round-trips starve under `bun test --parallel`; the runner's 5s
// default is too tight.
setDefaultTimeout(30_000);

let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.MIMIR_HOME;
  process.env.MIMIR_HOME = mkdtempSync(join(tmpdir(), "mimir-install-test-"));
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = savedHome;
});

const silent = () => {};

/** Serve fixed bytes and count hits. */
const withByteServer = async (
  bytes: Uint8Array,
  fn: (url: string, hits: () => number) => Promise<void>,
) => {
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    fetch: () => {
      hits++;
      return new Response(bytes);
    },
  });
  await fn(`http://127.0.0.1:${server.port}/asset`, () => hits).finally(() =>
    server.stop(true),
  );
};

const sha256Of = (bytes: Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

describe("sha256File", () => {
  test("streams a file to the expected digest", async () => {
    const path = join(process.env.MIMIR_HOME as string, "fixture.bin");
    await Bun.write(path, "hello");
    expect(await sha256File(path)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("installEmbedderModel", () => {
  const bytes = new TextEncoder().encode("fake-gguf-bytes");

  test("downloads, verifies, renames into place; second run skips", async () => {
    await withByteServer(bytes, async (url, hits) => {
      const good = sha256Of(bytes);
      const [err, path] = await installEmbedderModel(silent, {
        url,
        expectedSha256: good,
      });
      expect(err).toBeNull();
      expect(path).toBe(embedderModelPath());
      expect(await Bun.file(embedderModelPath()).text()).toBe(
        "fake-gguf-bytes",
      );
      expect(hits()).toBe(1);

      // Present + hash-valid → no second download.
      const [err2] = await installEmbedderModel(silent, {
        url,
        expectedSha256: good,
      });
      expect(err2).toBeNull();
      expect(hits()).toBe(1);
    });
  });

  test("hash mismatch refuses to install and removes the partial", async () => {
    await withByteServer(bytes, async (url) => {
      const [err] = await installEmbedderModel(silent, {
        url,
        expectedSha256: "0".repeat(64),
      });
      expect(err?.message).toContain("sha256 mismatch");
      expect(err?.message).toContain("vector-space contract");
      expect(await Bun.file(embedderModelPath()).exists()).toBe(false);
      const partials = await Array.fromAsync(
        new Bun.Glob("*.partial").scan(embedderDir()),
      );
      expect(partials).toEqual([]);
    });
  });

  test("stalled download aborts instead of hanging forever", async () => {
    // One chunk, then silence — the watchdog must kill it.
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start: (controller) => {
              controller.enqueue(new TextEncoder().encode("partial-"));
              // never closes, never enqueues again
            },
          }),
        ),
    });
    const [err] = await installEmbedderModel(silent, {
      url: `http://127.0.0.1:${server.port}/stalls`,
      expectedSha256: "0".repeat(64),
      stallMs: 250,
    });
    server.stop(true);
    expect(err?.message).toContain("stalled");
  });

  test("HTTP failure surfaces as an error", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("gone", { status: 404 }),
    });
    const [err] = await installEmbedderModel(silent, {
      url: `http://127.0.0.1:${server.port}/missing`,
      expectedSha256: "0".repeat(64),
    });
    server.stop(true);
    expect(err?.message).toContain("HTTP 404");
  });
});

describe("installLlamaServer", () => {
  /** Real tar.gz mimicking the release layout: llama-<tag>/{files}. */
  const buildFixtureArchive = async () => {
    const stage = mkdtempSync(join(tmpdir(), "mimir-llama-fixture-"));
    const inner = join(stage, `llama-${LLAMA_CPP_RELEASE.tag}`);
    await mkdir(inner, { recursive: true });
    await Bun.write(join(inner, "llama-server"), "#!/bin/sh\necho fake\n");
    await Bun.write(join(inner, "libggml.dylib"), "fake-lib");
    await Bun.write(join(inner, "llama-cli"), "unwanted-binary");
    await Bun.write(join(inner, "README.md"), "docs");
    const archive = join(stage, "release.tar.gz");
    await $`tar -czf ${archive} -C ${stage} llama-${LLAMA_CPP_RELEASE.tag}`.quiet();
    return archive;
  };

  test("extracts server + libs only, marks the tag, skips when current", async () => {
    const archiveBytes = new Uint8Array(
      await Bun.file(await buildFixtureArchive()).arrayBuffer(),
    );
    await withByteServer(archiveBytes, async (url, hits) => {
      const [err, binary] = await installLlamaServer(silent, { url });
      expect(err).toBeNull();
      expect(binary).toBe(embedderBinaryPath());
      expect(await Bun.file(embedderBinaryPath()).exists()).toBe(true);
      expect(
        await Bun.file(join(embedderDir(), "libggml.dylib")).exists(),
      ).toBe(true);
      // Unwanted siblings dropped; archive + temp dir cleaned up.
      expect(await Bun.file(join(embedderDir(), "llama-cli")).exists()).toBe(
        false,
      );
      expect(await Bun.file(join(embedderDir(), "README.md")).exists()).toBe(
        false,
      );

      // Tag marker matches the pin → second run is a no-op.
      const [err2] = await installLlamaServer(silent, { url });
      expect(err2).toBeNull();
      expect(hits()).toBe(1);
    });
  });

  test("a different asset variant at the same tag re-downloads", async () => {
    const archiveBytes = new Uint8Array(
      await Bun.file(await buildFixtureArchive()).arrayBuffer(),
    );
    await withByteServer(archiveBytes, async (url, hits) => {
      const cpu = "ubuntu-x64";
      const vulkan = "ubuntu-vulkan-x64";
      expect(
        (await installLlamaServer(silent, { url, assetSuffix: cpu }))[0],
      ).toBeNull();
      expect(hits()).toBe(1);

      // Same tag, same variant → still a no-op.
      await installLlamaServer(silent, { url, assetSuffix: cpu });
      expect(hits()).toBe(1);

      // A GPU runtime appeared (or the probe changed): the variant differs,
      // so the pinned tag alone must not count as "already installed".
      const [err] = await installLlamaServer(silent, {
        url,
        assetSuffix: vulkan,
      });
      expect(err).toBeNull();
      expect(hits()).toBe(2);
      const marker = await Bun.file(
        join(embedderDir(), ".llama-cpp-tag"),
      ).text();
      expect(marker).toContain(LLAMA_CPP_RELEASE.tag);
      expect(marker).toContain(vulkan);
    });
  });

  test("a legacy tag-only marker is treated as stale", async () => {
    const archiveBytes = new Uint8Array(
      await Bun.file(await buildFixtureArchive()).arrayBuffer(),
    );
    await withByteServer(archiveBytes, async (url, hits) => {
      // Pre-variant installs wrote just the tag and shipped the CPU build.
      await mkdir(embedderDir(), { recursive: true });
      await Bun.write(embedderBinaryPath(), "#!/bin/sh\necho old\n");
      await Bun.write(
        join(embedderDir(), ".llama-cpp-tag"),
        LLAMA_CPP_RELEASE.tag,
      );

      const [err] = await installLlamaServer(silent, {
        url,
        assetSuffix: "ubuntu-vulkan-x64",
      });
      expect(err).toBeNull();
      expect(hits()).toBe(1);
      expect(await Bun.file(embedderBinaryPath()).text()).toBe(
        "#!/bin/sh\necho fake\n",
      );
    });
  });

  test("archive without llama-server errors loudly", async () => {
    const stage = mkdtempSync(join(tmpdir(), "mimir-llama-empty-"));
    const inner = join(stage, "llama-whatever");
    await mkdir(inner, { recursive: true });
    await Bun.write(join(inner, "README.md"), "nothing useful");
    const archive = join(stage, "bad.tar.gz");
    await $`tar -czf ${archive} -C ${stage} llama-whatever`.quiet();

    const bytes = new Uint8Array(await Bun.file(archive).arrayBuffer());
    await withByteServer(bytes, async (url) => {
      const [err] = await installLlamaServer(silent, { url });
      expect(err?.message).toContain("did not contain llama-server");
    });
  });
});
