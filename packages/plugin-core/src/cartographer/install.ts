/**
 * Cartographer binary acquisition — the one way the installers get a
 * cartographer. Downloads the latest GitHub release of RageLtd/cartographer
 * (public, per-platform raw binaries) into ~/.mimir/bin and records the
 * tag, so a later install/update re-downloads only when a newer release
 * exists. Binaries elsewhere on the machine are deliberately ignored.
 *
 * Tracks LATEST rather than a pinned tag by the project owner's call: the
 * same person releases both, so a release never changes the parse output
 * the hooks consume without this repo moving with it.
 *
 * Failure policy: a release check that fails with a binary already on disk
 * keeps the binary (an install never blocks on GitHub being reachable);
 * with nothing on disk it fails the install — the index legs must not go
 * dark silently. `--cartographer PATH` stays the escape hatch.
 */

import { chmod, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { $ } from "bun";
import { downloadTo } from "../download";
import { attempt } from "../result";
import { mimirHome } from "../util";
import { isExecutableFile } from "./resolve";

export const CARTOGRAPHER_REPO = "RageLtd/cartographer";
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_DOWNLOAD_URL = "https://github.com";
const BINARY_NAME = "cartographer";
const TAG_MARKER_FILENAME = ".cartographer-tag";
const PARTIAL_SUFFIX = ".partial";

type ProgressLog = (message: string) => void;

/** Release asset for this machine, or null when cartographer has none. */
export const cartographerAssetName = () => {
  const { platform, arch } = process;
  if (platform === "darwin" && arch === "arm64")
    return `${BINARY_NAME}-darwin-arm64`;
  if (platform === "darwin" && arch === "x64")
    return `${BINARY_NAME}-darwin-x64`;
  if (platform === "linux" && arch === "x64") return `${BINARY_NAME}-linux-x64`;
  return null;
};

export const cartographerBinaryPath = () =>
  join(mimirHome(), "bin", BINARY_NAME);

const tagMarkerPath = () => join(mimirHome(), "bin", TAG_MARKER_FILENAME);

export const fetchLatestCartographerTag = async (
  apiBaseUrl: string = GITHUB_API_URL,
) =>
  attempt(async () => {
    const res = await fetch(
      `${apiBaseUrl}/repos/${CARTOGRAPHER_REPO}/releases/latest`,
      { headers: { Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) throw new Error(`release lookup failed: HTTP ${res.status}`);
    // Serialisation boundary — GitHub's payload shape is only known at
    // runtime.
    const body = (await res.json()) as { readonly tag_name?: unknown };
    if (typeof body.tag_name !== "string" || body.tag_name.length === 0) {
      throw new Error("release lookup returned no tag_name");
    }
    return body.tag_name;
  });

/**
 * Ad-hoc sign on macOS. Cross-built release binaries arrive unsigned and
 * Apple Silicon refuses to exec those; cartographer's own installer does
 * the same. A signing failure is reported, not fatal — the binary may
 * already carry a valid signature.
 */
const signBinary = async (binary: string, log: ProgressLog) => {
  if (process.platform !== "darwin") return;
  const [err] = await attempt(async () => {
    await $`codesign --force --sign - ${binary}`.quiet();
  });
  if (err) log(`cartographer: codesign failed (${err.message}) — continuing`);
};

export type InstallCartographerOptions = {
  /** GitHub API origin — tests point this at a local server. */
  readonly apiBaseUrl?: string;
  /** Release download origin — tests point this at a local server. */
  readonly downloadBaseUrl?: string;
  /** Injectable signer — tests skip codesign. */
  readonly sign?: (binary: string, log: ProgressLog) => Promise<void>;
};

/** Ensure the latest cartographer release is installed. Returns [error, path]. */
export const installCartographer = async (
  log: ProgressLog,
  opts: InstallCartographerOptions = {},
) =>
  attempt(async () => {
    const binary = cartographerBinaryPath();
    const marker = Bun.file(tagMarkerPath());
    const installedTag = (await marker.exists())
      ? (await marker.text()).trim()
      : null;
    const haveBinary = isExecutableFile(binary);

    const [tagErr, latest] = await fetchLatestCartographerTag(opts.apiBaseUrl);
    if (tagErr) {
      if (haveBinary) {
        log(
          `cartographer: release check failed (${tagErr.message}) — keeping installed ${installedTag ?? "binary"}`,
        );
        return binary;
      }
      throw new Error(
        `cartographer release lookup failed and no binary is installed: ${tagErr.message}`,
      );
    }
    if (haveBinary && installedTag === latest) {
      log(`cartographer ${latest} already installed`);
      return binary;
    }

    const asset = cartographerAssetName();
    if (asset === null) {
      throw new Error(
        `unsupported platform ${process.platform}/${process.arch} — no cartographer release asset; pass --cartographer PATH`,
      );
    }

    const url = `${opts.downloadBaseUrl ?? GITHUB_DOWNLOAD_URL}/${CARTOGRAPHER_REPO}/releases/download/${latest}/${asset}`;
    log(`downloading cartographer ${latest} (${asset})`);
    await mkdir(join(mimirHome(), "bin"), { recursive: true });
    const partial = `${binary}${PARTIAL_SUFFIX}`;
    await downloadTo(url, partial);
    await chmod(partial, 0o755);
    await rename(partial, binary);
    await (opts.sign ?? signBinary)(binary, log);
    await Bun.write(tagMarkerPath(), latest);
    log(`cartographer installed: ${binary}`);
    return binary;
  });
