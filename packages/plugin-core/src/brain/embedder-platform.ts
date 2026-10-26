/**
 * Which llama.cpp release, and which build of it, this machine should run.
 *
 * The pinned tag is one pin for every platform; the *variant* is chosen per
 * host so a GPU is used when its runtime is present. Everything here is
 * decided from files on disk — no binaries are executed to find out.
 *
 * macOS: the arm64 asset is built with Metal and llama-server's `-ngl`
 * defaults to `auto`, so Apple Silicon offloads to the GPU with no flags;
 * the x64 asset is built with `GGML_METAL=OFF` upstream, so Intel Macs are
 * CPU-only and there is nothing to probe. Linux: the plain `ubuntu-*` asset
 * is CPU-only — a dedicated GPU sits idle and every embedding batch runs on
 * cores — so pick a GPU variant when its runtime is present. Upstream builds
 * every Linux asset with `GGML_BACKEND_DL=ON`: a GPU backend whose runtime
 * cannot load is skipped at startup and the server falls back to the
 * bundled CPU backends, so a wrong pick degrades rather than breaks.
 */

import { existsSync, readFileSync } from "node:fs";

/** A CUDA build published for the pinned tag. `minDriverMajor` is NVIDIA's
 *  minor-version-compatibility floor for that CUDA major (13.x → R580,
 *  12.x → R525); the runtime libraries themselves ship in the companion
 *  `cudart-*` archive, so the driver is the only host requirement. */
type CudaVariant = {
  readonly variant: string;
  readonly archs: readonly string[];
  readonly minDriverMajor: number;
};

/** Newest CUDA first; the first variant the driver can run wins. */
const CUDA_VARIANTS: readonly CudaVariant[] = [
  { variant: "cuda-13.4", archs: ["x64", "arm64"], minDriverMajor: 580 },
  { variant: "cuda-12.8", archs: ["x64"], minDriverMajor: 525 },
];

export const LLAMA_CPP_RELEASE = {
  tag: "b11889",
  baseUrl: "https://github.com/ggml-org/llama.cpp/releases/download",
  /** GPU builds published for this tag. Every field here is tag-specific:
   *  re-check the release's asset list when bumping `tag`.
   *
   *  `hipMajor` is the HIP runtime soname major (`libamdhip64.so.<n>`),
   *  which is decoupled from the ROCm version — ROCm 7.x through 10.x all
   *  ship HIP 7, so the ROCm 10.0 build still loads against `.so.7`. */
  rocm: { variant: "rocm-10.0", hipMajor: 7 },
  cuda: CUDA_VARIANTS,
} as const;

/** Library directories across distro layouts: Arch/Fedora-style flat
 *  dirs, Debian/Ubuntu multiarch, and ROCm's own prefix. */
const LINUX_LIB_DIRS = [
  "/opt/rocm/lib",
  "/usr/lib",
  "/usr/lib64",
  "/usr/lib/x86_64-linux-gnu",
  "/usr/lib/aarch64-linux-gnu",
] as const;

/** The HIP runtime's soname carries its major version (`.so.6` for ROCm 6,
 *  `.so.7` for ROCm 7–10), so probing for the exact major is the ABI check
 *  a build linked against a given HIP needs. */
const hipRuntimeCandidates = (hipMajor: number) =>
  LINUX_LIB_DIRS.map((dir) => `${dir}/libamdhip64.so.${hipMajor}`);

/** The Vulkan ICD loader; llama.cpp's Vulkan backend dlopens it. */
const VULKAN_LOADER_CANDIDATES = LINUX_LIB_DIRS.map(
  (dir) => `${dir}/libvulkan.so.1`,
);

/** The facts the variant choice needs about the host — injectable so tests
 *  can describe a machine without touching one. */
export type HostProbe = {
  readonly fileExists: (path: string) => boolean;
  /** Major of the loaded NVIDIA kernel driver, or null when none is loaded. */
  readonly nvidiaDriverMajor: () => number | null;
};

/** Present whenever the NVIDIA kernel module is loaded, regardless of how
 *  the driver was installed. First line reads like
 *  `NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  580.95.05  Release Build …`. */
const NVIDIA_DRIVER_VERSION_FILE = "/proc/driver/nvidia/version";

export const parseNvidiaDriverMajor = (text: string) => {
  const match = /\b(\d{3})\.\d+/.exec(text);
  return match?.[1] === undefined ? null : Number(match[1]);
};

const readNvidiaDriverMajor = () =>
  existsSync(NVIDIA_DRIVER_VERSION_FILE)
    ? parseNvidiaDriverMajor(readFileSync(NVIDIA_DRIVER_VERSION_FILE, "utf8"))
    : null;

export const hostProbe: HostProbe = {
  fileExists: existsSync,
  nvidiaDriverMajor: readNvidiaDriverMajor,
};

/**
 * Which llama.cpp GPU build a Linux host can run, or null for CPU-only.
 *
 * Preference: CUDA (NVIDIA driver loaded and new enough for a published
 * CUDA major) → ROCm (native HIP, fastest on AMD; x64 assets only) →
 * Vulkan (any vendor through Mesa or vendor drivers, nothing extra to
 * install) → none.
 */
export const linuxGpuVariant = (arch: string, probe: HostProbe = hostProbe) => {
  const driver = probe.nvidiaDriverMajor();
  if (driver !== null) {
    const cuda = LLAMA_CPP_RELEASE.cuda.find(
      (candidate) =>
        candidate.archs.includes(arch) && driver >= candidate.minDriverMajor,
    );
    if (cuda) return cuda.variant;
  }
  if (
    arch === "x64" &&
    hipRuntimeCandidates(LLAMA_CPP_RELEASE.rocm.hipMajor).some(probe.fileExists)
  ) {
    return LLAMA_CPP_RELEASE.rocm.variant;
  }
  if (VULKAN_LOADER_CANDIDATES.some(probe.fileExists)) return "vulkan";
  return null;
};

/** GitHub asset suffix for this machine, or null when unsupported. */
export const platformAssetSuffix = (probe: HostProbe = hostProbe) => {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64") return "macos-arm64";
  if (platform === "darwin" && arch === "x64") return "macos-x64";
  if (platform === "linux" && (arch === "x64" || arch === "arm64")) {
    const gpu = linuxGpuVariant(arch, probe);
    return gpu === null ? `ubuntu-${arch}` : `ubuntu-${gpu}-${arch}`;
  }
  return null;
};

export const llamaCppAssetUrl = (suffix: string) =>
  `${LLAMA_CPP_RELEASE.baseUrl}/${LLAMA_CPP_RELEASE.tag}/llama-${LLAMA_CPP_RELEASE.tag}-bin-${suffix}.tar.gz`;

const CUDA_SUFFIX_MARKER = "-cuda-";
export const isCudaSuffix = (suffix: string) =>
  suffix.includes(CUDA_SUFFIX_MARKER);

/** The companion archive carrying the CUDA runtime libraries for a CUDA suffix. */
export const cudaRuntimeAssetUrl = (suffix: string) =>
  `${LLAMA_CPP_RELEASE.baseUrl}/${LLAMA_CPP_RELEASE.tag}/cudart-llama-${LLAMA_CPP_RELEASE.tag}-bin-${suffix}.tar.gz`;
