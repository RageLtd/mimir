/**
 * Embedder artifact acquisition (MIM-85) — the install story owns the
 * ~640MB model + llama.cpp binary fetch explicitly, so no hook ever
 * triggers a surprise download. Called from installer flows (mimir-cc
 * install/update); runtime code (embedder.ts) only checks presence. Which
 * release and which build variant to fetch is decided in
 * embedder-platform.ts.
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
 * Release archive layout (verified against b11889): a single top-level
 * `llama-<tag>/` dir with llama-server + its dylibs/sos flat inside. The
 * CUDA variants ship a second archive, `cudart-llama-<tag>-bin-<suffix>/`,
 * holding libcudart/libcublas/libcublasLt; the binaries carry an `$ORIGIN`
 * rpath, so dropping those next to llama-server is all the install needs —
 * the host only has to have the NVIDIA driver. We extract each archive to a
 * temp dir and keep only llama-server + lib* — portable across BSD/GNU tar,
 * no --wildcards divergence.
 */

import { chmod, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { downloadTo } from "../download";
import { attempt } from "../result";
import {
  EMBEDDER_MODEL,
  embedderBinaryPath,
  embedderDir,
  embedderModelPath,
} from "./embedder";
import {
  cudaRuntimeAssetUrl,
  isCudaSuffix,
  LLAMA_CPP_RELEASE,
  llamaCppAssetUrl,
  platformAssetSuffix,
} from "./embedder-platform";

const BINARY_NAME = "llama-server";
const LIB_PREFIX = "lib";
/** Records which release tag AND asset variant the installed binary came
 *  from (`<tag> <suffix>`) — a tag bump or a variant change (CPU → Vulkan →
 *  ROCm/CUDA as runtimes show up) triggers re-download on the next
 *  install/update. Pre-variant installs wrote the bare tag; that never
 *  matches, so they re-download once. */
const TAG_MARKER_FILENAME = ".llama-cpp-tag";
const PARTIAL_SUFFIX = ".partial";

type ProgressLog = (message: string) => void;

const tagMarkerPath = () => join(embedderDir(), TAG_MARKER_FILENAME);
const installedMarker = (suffix: string) =>
  `${LLAMA_CPP_RELEASE.tag} ${suffix}`;

export const sha256File = async (path: string) => {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
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
 * Download a release archive and move its server binary and shared
 * libraries into `dir`, discarding everything else. Returns how many files
 * were kept. Extraction goes through a temp dir on the same volume so a
 * failure never leaves half an install behind.
 */
const fetchAndKeepLibs = async (url: string, dir: string) => {
  const archive = join(dir, `llama-cpp${PARTIAL_SUFFIX}.tar.gz`);
  await downloadTo(url, archive);

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
  return kept;
};

/**
 * Ensure the pinned-tag llama-server binary (+ its shared libs) is
 * installed, in the right variant for this machine. CUDA variants also
 * pull the companion runtime-library archive. Skips when the marker matches
 * both the pinned tag and the variant. Returns [error, binaryPath].
 */
export const installLlamaServer = async (
  log: ProgressLog,
  opts: {
    readonly url?: string;
    /** Test seam — the CUDA runtime bundle; defaults from the suffix. */
    readonly runtimeUrl?: string;
    /** Test seam — production callers let the platform probe decide. */
    readonly assetSuffix?: string;
  } = {},
) =>
  attempt(async () => {
    const dir = embedderDir();
    const binary = embedderBinaryPath();
    await mkdir(dir, { recursive: true });

    const suffix = opts.assetSuffix ?? platformAssetSuffix();
    if (suffix === null) {
      throw new Error(
        `unsupported platform ${process.platform}/${process.arch} — no llama.cpp release asset; embedding stays text-only`,
      );
    }

    const marker = Bun.file(tagMarkerPath());
    if (
      (await Bun.file(binary).exists()) &&
      (await marker.exists()) &&
      (await marker.text()).trim() === installedMarker(suffix)
    ) {
      log(
        `llama-server ${LLAMA_CPP_RELEASE.tag} (${suffix}) already installed`,
      );
      return binary;
    }

    const url = opts.url ?? llamaCppAssetUrl(suffix);
    log(`downloading llama.cpp ${LLAMA_CPP_RELEASE.tag} (${suffix})`);
    const kept = await fetchAndKeepLibs(url, dir);
    if (kept === 0 || !(await Bun.file(binary).exists())) {
      throw new Error(
        `archive from ${url} did not contain ${BINARY_NAME} — release layout changed?`,
      );
    }

    const runtimeUrl =
      opts.runtimeUrl ??
      (isCudaSuffix(suffix) ? cudaRuntimeAssetUrl(suffix) : null);
    if (runtimeUrl !== null) {
      log(`downloading CUDA runtime libraries for ${suffix}`);
      const runtimeLibs = await fetchAndKeepLibs(runtimeUrl, dir);
      if (runtimeLibs === 0) {
        throw new Error(
          `runtime archive from ${runtimeUrl} contained no libraries — release layout changed?`,
        );
      }
    }

    await chmod(binary, 0o755);
    await Bun.write(tagMarkerPath(), installedMarker(suffix));
    log(`llama-server installed (${suffix}): ${binary}`);
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
