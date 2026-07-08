/**
 * Embedder artifact acquisition (MIM-85) — the install story owns the
 * ~640MB model + llama.cpp binary fetch explicitly, so no hook ever
 * triggers a surprise download. Called from installer flows (mimir-cc
 * install/update); runtime code (embedder.ts) only checks presence.
 *
 * Verification policy, deliberately asymmetric:
 *   - The GGUF is sha256-PINNED (EMBEDDER_MODEL.sha256): the artifact hash
 *     IS the org vector-space contract — a different quant silently forks
 *     the space. Mismatch = delete + hard error, never "close enough".
 *   - The llama.cpp binary is pinned by RELEASE TAG over GitHub TLS. A
 *     per-platform hash table would be four hashes to maintain per bump
 *     with no vector-space stake; the binary can't poison the space, only
 *     fail to serve.
 *
 * Release archive layout (verified against b9912): a single top-level
 * `llama-<tag>/` dir with llama-server + its dylibs/sos flat inside.
 * We extract to a temp dir and keep only llama-server + lib* — portable
 * across BSD/GNU tar, no --wildcards divergence.
 */

import { chmod, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { attempt } from "../result";
import {
  EMBEDDER_MODEL,
  embedderBinaryPath,
  embedderDir,
  embedderModelPath,
} from "./embedder";

export const LLAMA_CPP_RELEASE = {
  tag: "b9912",
  baseUrl: "https://github.com/ggml-org/llama.cpp/releases/download",
} as const;

const BINARY_NAME = "llama-server";
const LIB_PREFIX = "lib";
/** Records which release tag the installed binary came from — tag bump
 *  triggers re-download on the next install/update run. */
const TAG_MARKER_FILENAME = ".llama-cpp-tag";
const PARTIAL_SUFFIX = ".partial";

type ProgressLog = (message: string) => void;

/** GitHub asset suffix for this machine, or null when unsupported. */
export const platformAssetSuffix = () => {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "darwin" && arch === "x64") return "macos-x64";
  if (platform === "linux" && arch === "x64") return "ubuntu-x64";
  if (platform === "linux" && arch === "arm64") return "ubuntu-arm64";
  return null;
};

export const llamaCppAssetUrl = (suffix: string) =>
  `${LLAMA_CPP_RELEASE.baseUrl}/${LLAMA_CPP_RELEASE.tag}/llama-${LLAMA_CPP_RELEASE.tag}-bin-${suffix}.tar.gz`;

const tagMarkerPath = () => join(embedderDir(), TAG_MARKER_FILENAME);

export const sha256File = async (path: string) => {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
};

/** Abort when zero bytes arrive for this long. A rolling deadline, not an
 *  overall one — slow links are fine, dead connections are not. (Learned
 *  live: a wedged CDN connection stalled a signal-less fetch forever.) */
const DOWNLOAD_STALL_MS = 30_000;

const downloadTo = async (
  url: string,
  dest: string,
  stallMs: number = DOWNLOAD_STALL_MS,
) => {
  const controller = new AbortController();
  const stalled = () =>
    controller.abort(new Error(`download stalled ${stallMs}ms: ${url}`));
  let watchdog = setTimeout(stalled, stallMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`download failed: HTTP ${res.status} for ${url}`);
    }
    if (!res.body) throw new Error(`download failed: empty body for ${url}`);

    // Stream to disk chunk-by-chunk, resetting the watchdog per chunk —
    // an interrupted run leaves a partial the next attempt overwrites.
    const writer = Bun.file(dest).writer();
    for await (const chunk of res.body) {
      clearTimeout(watchdog);
      watchdog = setTimeout(stalled, stallMs);
      writer.write(chunk);
    }
    await writer.end();
  } finally {
    clearTimeout(watchdog);
  }
};

/**
 * Ensure the pinned GGUF is on disk and hash-valid. An existing file is
 * re-hashed (a ~1s read) rather than trusted — cheap insurance on the
 * artifact whose identity everything else depends on. Returns [error, path].
 */
export const installEmbedderModel = async (
  log: ProgressLog,
  opts: {
    readonly url?: string;
    /** Test seams only — production callers never override the pin. */
    readonly expectedSha256?: string;
    readonly stallMs?: number;
  } = {},
) =>
  attempt(async () => {
    const dest = embedderModelPath();
    const url = opts.url ?? EMBEDDER_MODEL.url;
    const expected = opts.expectedSha256 ?? EMBEDDER_MODEL.sha256;
    await mkdir(embedderDir(), { recursive: true });

    if (await Bun.file(dest).exists()) {
      const existing = await sha256File(dest);
      if (existing === expected) {
        log(`embedding model present and hash-valid: ${dest}`);
        return dest;
      }
      log(`embedding model hash mismatch — re-downloading (${existing})`);
      await rm(dest);
    }

    const mb = Math.round(EMBEDDER_MODEL.bytes / 1024 / 1024);
    log(`downloading ${EMBEDDER_MODEL.file} (~${mb}MB) from ${url}`);
    const partial = dest + PARTIAL_SUFFIX;
    await downloadTo(url, partial, opts.stallMs);

    const actual = await sha256File(partial);
    if (actual !== expected) {
      await rm(partial);
      throw new Error(
        `GGUF sha256 mismatch: expected ${expected}, got ${actual} — refusing to install (org vector-space contract)`,
      );
    }
    await rename(partial, dest);
    log(`embedding model installed: ${dest}`);
    return dest;
  });

/**
 * Ensure the pinned-tag llama-server binary (+ its shared libs) is
 * installed. Skips when the tag marker matches the pin. Returns
 * [error, binaryPath].
 */
export const installLlamaServer = async (
  log: ProgressLog,
  opts: { readonly url?: string } = {},
) =>
  attempt(async () => {
    const dir = embedderDir();
    const binary = embedderBinaryPath();
    await mkdir(dir, { recursive: true });

    const marker = Bun.file(tagMarkerPath());
    if (
      (await Bun.file(binary).exists()) &&
      (await marker.exists()) &&
      (await marker.text()).trim() === LLAMA_CPP_RELEASE.tag
    ) {
      log(`llama-server ${LLAMA_CPP_RELEASE.tag} already installed`);
      return binary;
    }

    const suffix = platformAssetSuffix();
    if (suffix === null) {
      throw new Error(
        `unsupported platform ${process.platform}/${process.arch} — no llama.cpp release asset; embedding stays text-only`,
      );
    }

    const url = opts.url ?? llamaCppAssetUrl(suffix);
    log(`downloading llama.cpp ${LLAMA_CPP_RELEASE.tag} (${suffix})`);
    const archive = join(dir, `llama-cpp${PARTIAL_SUFFIX}.tar.gz`);
    await downloadTo(url, archive);

    // Extract everything to a temp dir on the same volume, then keep only
    // the server binary and its libs.
    const extractDir = join(dir, ".extract-tmp");
    await rm(extractDir, { recursive: true, force: true });
    await mkdir(extractDir, { recursive: true });
    await $`tar -xzf ${archive} --strip-components=1 -C ${extractDir}`.quiet();

    let kept = 0;
    for (const entry of await readdir(extractDir)) {
      if (entry === BINARY_NAME || entry.startsWith(LIB_PREFIX)) {
        await rename(join(extractDir, entry), join(dir, entry));
        kept++;
      }
    }
    await rm(extractDir, { recursive: true, force: true });
    await rm(archive);

    if (kept === 0 || !(await Bun.file(binary).exists())) {
      throw new Error(
        `archive from ${url} did not contain ${BINARY_NAME} — release layout changed?`,
      );
    }

    await chmod(binary, 0o755);
    await Bun.write(tagMarkerPath(), LLAMA_CPP_RELEASE.tag);
    log(`llama-server installed: ${binary}`);
    return binary;
  });

/** Full acquisition: binary first (small), then the model (large). */
export const installEmbedderArtifacts = async (
  log: ProgressLog,
  opts: {
    readonly modelUrl?: string;
    readonly binaryUrl?: string;
  } = {},
) => {
  const [binErr] = await installLlamaServer(log, { url: opts.binaryUrl });
  if (binErr) return binErr;
  const [modelErr] = await installEmbedderModel(log, { url: opts.modelUrl });
  if (modelErr) return modelErr;
  return null;
};
