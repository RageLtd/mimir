/**
 * Cartographer reindex workers for the OpenCode plugin.
 *
 * Two detached, short-lived flows: `runReindexWorker` reparses a single
 * edited file (driven by the `file.edited` event); `runFullReindex` walks
 * every git-tracked file at session start and syncs them as one
 * replace-mode payload. Both spawn the Rust binary, parse, sync to
 * mimir-server, and kill the process — no long-lived cartographer state.
 *
 * Extracted from index.ts to keep the plugin entry under the file-length
 * limit; the entry wires these to events and owns the fire-and-forget
 * `.catch()`.
 */

import { spawnCartographer } from "@mimir/plugin-core/cartographer/client";
import { syncIndex } from "@mimir/plugin-core/cartographer/sync";
import type { createLoggerFactory } from "@mimir/plugin-core/logger";
import { getOrResolveProjectId } from "@mimir/plugin-core/project";
import { errMessage } from "@mimir/plugin-core/util";
import { authHeaders, type MimirConfig } from "./config";

type Logger = ReturnType<
  ReturnType<typeof createLoggerFactory>["createLogger"]
>;

/**
 * Reparse a single edited file and upsert it into the index. Skips
 * silently when no cartographer binary is configured.
 */
export const runReindexWorker = async (
  log: Logger,
  config: MimirConfig,
  projectPath: string,
  filePath: string,
) => {
  if (!config.cartographerBinary) {
    log.debug("no cartographer binary configured — skipping reindex", {
      filePath,
    });
    return;
  }

  const client = await spawnCartographer(
    config.cartographerBinary,
    projectPath,
  ).catch((err) => {
    log.error("cartographer spawn failed", {
      error: errMessage(err),
      filePath,
    });
    return null;
  });
  if (!client) return;

  const parsed = await client.parseFile(projectPath, filePath).catch((err) => {
    log.error("parseFile failed", { filePath, error: errMessage(err) });
    return null;
  });
  client.kill();
  if (!parsed) return;

  const projectId = await getOrResolveProjectId(
    config.serverUrl,
    projectPath,
    config.apiKey,
  ).catch(() => null);

  const headers = await authHeaders();
  const result = await syncIndex(
    { serverUrl: config.serverUrl, ...headers },
    projectPath,
    [parsed],
    projectId,
    "upsert",
  );
  if (!result.ok) {
    log.error("syncIndex returned !ok", { filePath, error: result.error });
  }
};

/**
 * Full project reindex: walk every git-tracked source file, parse each,
 * sync as a single replace-mode payload. Spawn a detached worker so
 * session startup isn't blocked on it.
 */
export const runFullReindex = async (
  log: Logger,
  config: MimirConfig,
  projectPath: string,
) => {
  if (!config.cartographerBinary) {
    log.debug("no cartographer binary configured — skipping full reindex");
    return;
  }

  const proc = Bun.spawn(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: projectPath, stdout: "pipe", stderr: "pipe" },
  );
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    log.warn("git ls-files failed", { exitCode });
    return;
  }
  const text = await new Response(proc.stdout).text();
  const files = text.split("\n").filter((f) => f.length > 0);
  if (files.length === 0) {
    log.warn("no git-tracked files found — skipping full reindex");
    return;
  }

  const client = await spawnCartographer(
    config.cartographerBinary,
    projectPath,
  ).catch((err) => {
    log.error("cartographer spawn failed", { error: errMessage(err) });
    return null;
  });
  if (!client) return;

  const parsed = [];
  for (const file of files) {
    const result = await client.parseFile(projectPath, file).catch(() => null);
    if (result) parsed.push(result);
  }
  client.kill();
  if (parsed.length === 0) {
    log.warn("no files parsed successfully", { attempted: files.length });
    return;
  }

  const projectId = await getOrResolveProjectId(
    config.serverUrl,
    projectPath,
    config.apiKey,
  ).catch(() => null);

  const headers = await authHeaders();
  const result = await syncIndex(
    { serverUrl: config.serverUrl, ...headers },
    projectPath,
    parsed,
    projectId,
    "replace",
  );
  if (!result.ok) {
    log.error("syncIndex returned !ok", { error: result.error });
  }
  log.info("session-start reindex complete", {
    fileCount: files.length,
    parsed: parsed.length,
    syncOk: result.ok,
  });
};
