/**
 * Variant selection tests — machines are described by the files they have
 * and the NVIDIA driver they run, so every branch is exercised on any host.
 */

import { describe, expect, test } from "bun:test";
import {
  cudaRuntimeAssetUrl,
  type HostProbe,
  isCudaSuffix,
  LLAMA_CPP_RELEASE,
  linuxGpuVariant,
  llamaCppAssetUrl,
  parseNvidiaDriverMajor,
  platformAssetSuffix,
} from "./embedder-platform";

/** A machine described by the files it has and the NVIDIA driver it runs. */
const machine = (
  files: readonly string[],
  nvidiaDriver: number | null = null,
): HostProbe => ({
  fileExists: (path) => files.includes(path),
  nvidiaDriverMajor: () => nvidiaDriver,
});
const VULKAN = "/usr/lib/libvulkan.so.1";
const HIP7 = "/opt/rocm/lib/libamdhip64.so.7";
const nothing = machine([]);
const vulkanOnly = machine([VULKAN]);
const rocm7 = machine([HIP7, VULKAN]);
const rocm6Only = machine(["/opt/rocm/lib/libamdhip64.so.6", VULKAN]);
const nvidia580 = machine([VULKAN], 580);
const nvidia570 = machine([VULKAN], 570);
const nvidia470 = machine([VULKAN], 470);
const nvidiaAndRocm = machine([HIP7, VULKAN], 590);

describe("platform mapping", () => {
  test("this machine maps to a known asset suffix and URL", () => {
    // CI and dev boxes are darwin/linux on x64/arm64 — all supported.
    const suffix = platformAssetSuffix();
    expect(suffix).not.toBeNull();
    expect(llamaCppAssetUrl(suffix ?? "")).toBe(
      `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_RELEASE.tag}/llama-${LLAMA_CPP_RELEASE.tag}-bin-${suffix}.tar.gz`,
    );
  });

  test("Linux GPU variant: CUDA beats ROCm beats Vulkan beats CPU", () => {
    expect(linuxGpuVariant("x64", nvidia580)).toBe("cuda-13.4");
    expect(linuxGpuVariant("x64", nvidiaAndRocm)).toBe("cuda-13.4");
    expect(linuxGpuVariant("x64", rocm7)).toBe("rocm-10.0");
    expect(linuxGpuVariant("x64", vulkanOnly)).toBe("vulkan");
    expect(linuxGpuVariant("x64", nothing)).toBeNull();
  });

  test("CUDA line follows NVIDIA's driver floor; too old falls through", () => {
    // R580+ runs CUDA 13.x; R525–R579 only CUDA 12.x; older gets no CUDA.
    expect(linuxGpuVariant("x64", nvidia570)).toBe("cuda-12.8");
    expect(linuxGpuVariant("x64", nvidia470)).toBe("vulkan");
    // No CUDA 12.8 asset for arm64 — a 570 driver there means Vulkan.
    expect(linuxGpuVariant("arm64", nvidia580)).toBe("cuda-13.4");
    expect(linuxGpuVariant("arm64", nvidia570)).toBe("vulkan");
  });

  test("ROCm needs the HIP 7 soname and an x64 asset", () => {
    // ROCm 6 ships libamdhip64.so.6, which cannot load a HIP 7 build.
    expect(linuxGpuVariant("x64", rocm6Only)).toBe("vulkan");
    // No ROCm asset exists for arm64; Vulkan is the GPU path there.
    expect(linuxGpuVariant("arm64", rocm7)).toBe("vulkan");
  });

  test("the NVIDIA driver major is read from /proc's version line", () => {
    expect(
      parseNvidiaDriverMajor(
        "NVRM version: NVIDIA UNIX Open Kernel Module for x86_64  580.95.05  Release Build  (dvs-builder@U16-I3-B03-4-3)  Tue Sep 23 19:39:28 UTC 2025\nGCC version:  gcc version 14.2.0",
      ),
    ).toBe(580);
    expect(
      parseNvidiaDriverMajor(
        "NVRM version: NVIDIA UNIX x86_64 Kernel Module  570.133.07  Fri Mar 14 13:12:07 UTC 2025",
      ),
    ).toBe(570);
    expect(parseNvidiaDriverMajor("")).toBeNull();
    expect(parseNvidiaDriverMajor("no version here")).toBeNull();
  });

  test("the asset suffix follows the GPU probe on Linux and ignores it on macOS", () => {
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    if (process.platform === "linux") {
      expect(platformAssetSuffix(vulkanOnly)).toBe(`ubuntu-vulkan-${arch}`);
      expect(platformAssetSuffix(nothing)).toBe(`ubuntu-${arch}`);
      expect(platformAssetSuffix(nvidia580)).toBe(`ubuntu-cuda-13.4-${arch}`);
      if (arch === "x64") {
        expect(platformAssetSuffix(rocm7)).toBe("ubuntu-rocm-10.0-x64");
      }
    } else {
      // macOS arm64 ships Metal, x64 ships CPU-only; neither probes.
      expect(platformAssetSuffix(nvidiaAndRocm)).toBe(
        platformAssetSuffix(nothing),
      );
    }
  });

  test("CUDA suffixes name a companion runtime archive", () => {
    expect(isCudaSuffix("ubuntu-cuda-13.4-x64")).toBe(true);
    expect(isCudaSuffix("ubuntu-vulkan-x64")).toBe(false);
    expect(cudaRuntimeAssetUrl("ubuntu-cuda-13.4-x64")).toBe(
      `https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_CPP_RELEASE.tag}/cudart-llama-${LLAMA_CPP_RELEASE.tag}-bin-ubuntu-cuda-13.4-x64.tar.gz`,
    );
  });
});
