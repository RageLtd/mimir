/**
 * Claude Code SDK version check and auto-update.
 *
 * Anthropic bakes model metadata (names, descriptions, capabilities) into
 * the SDK package rather than fetching it live, so a stale SDK shows stale
 * model info in Zed's picker. On boot we compare the installed version
 * against the npm registry and spawn `bun update` if a newer release is
 * available.
 *
 * The update takes effect on the NEXT boot — the SDK module is already
 * loaded into this process when the check runs, so swapping the package
 * on disk doesn't affect the current session. This is actually desirable:
 * a broken release can't kill the running session, only affect the next
 * restart.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { errMessage } from "../../util";
import { createChildLogger, log } from "../../utils/log";

const logger = createChildLogger(log, "cc-sdk-updater");

const SDK_PACKAGE_NAME = "@anthropic-ai/claude-agent-sdk";
const REGISTRY_URL = `https://registry.npmjs.org/${SDK_PACKAGE_NAME}/latest`;
const REGISTRY_TIMEOUT_MS = 5_000;

/**
 * Read the installed SDK version from its package.json on disk.
 *
 * The SDK's exports map doesn't expose package.json, so we resolve the
 * main entry point and derive the package root from that. Returns null
 * if resolution fails (SDK not installed, package.json missing, etc).
 */
const readInstalledVersion = async () => {
  const mainUrl = await Promise.resolve()
    .then(() => import.meta.resolve(SDK_PACKAGE_NAME))
    .catch(errMessage);
  if (typeof mainUrl !== "string") return null;

  const pkgJsonPath = join(dirname(fileURLToPath(mainUrl)), "package.json");
  const pkg = await Bun.file(pkgJsonPath).json().catch(errMessage);
  if (typeof pkg === "string" || typeof pkg !== "object" || pkg === null) {
    return null;
  }

  const version = (pkg as { version?: string }).version;
  return typeof version === "string" ? version : null;
};

/**
 * Check the npm registry for a newer Claude Code SDK and run `bun update`
 * if one exists. Fire-and-forget — never throws, always returns when done.
 *
 * Network failures, registry parse errors, and install failures are all
 * logged at debug/warn and swallowed so boot always proceeds.
 */
export const checkForSdkUpdate = async () => {
  const installed = await readInstalledVersion();
  if (installed === null) {
    logger.debug("could not read installed SDK version, skipping update check");
    return;
  }

  const res = await fetch(REGISTRY_URL, {
    signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
  }).catch(errMessage);

  if (typeof res === "string") {
    logger.debug(`registry fetch failed: ${res}`);
    return;
  }

  if (!res.ok) {
    logger.debug(`registry returned ${res.status} ${res.statusText}`);
    return;
  }

  const body = await res.json().catch(errMessage);
  if (typeof body === "string" || typeof body !== "object" || body === null) {
    logger.debug("invalid registry response");
    return;
  }

  const latest = (body as { version?: string }).version;
  if (typeof latest !== "string") {
    logger.debug("registry response missing version");
    return;
  }

  if (latest === installed) {
    logger.debug(`CC SDK up to date (${installed})`);
    return;
  }

  logger.info(
    `CC SDK update available: ${installed} → ${latest} (running 'bun update')`,
  );

  const proc = Bun.spawn(["bun", "update", SDK_PACKAGE_NAME], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });

  const code = await proc.exited;

  if (code === 0) {
    logger.info(`CC SDK updated to ${latest} (takes effect on next boot)`);
    return;
  }

  const stderr = await new Response(proc.stderr).text();
  logger.warn(`CC SDK update failed (exit ${code}): ${stderr.slice(0, 500)}`);
};
