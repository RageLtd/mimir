/**
 * Engine type declarations for a worker worktree. Claude Code lays a
 * plugin's hook-module declarations into `<plugin dir>/.claude-plugin/types/`
 * when the plugin is loaded interactively, and that folder ignores itself
 * in git — so a fresh worker worktree lacks it and a typecheck that needs
 * it quietly skips. Carry it across from the coordinator's tree, beside
 * every plugin manifest the worker's tree tracks.
 *
 * Once per worktree (a marker under ~/.mimir/agents), never overwriting,
 * never throwing: a copy that fails is logged and the tool call goes on.
 *
 * A worker's first turn often sends several tool calls at once, each
 * running this in its own process, so the marker alone cannot serialise
 * them. Each process copies into a private staging folder and renames it
 * into place: rename is atomic and cannot replace a populated folder, so
 * `types/` lands whole or not at all, and every process removes only its
 * own staging folder.
 *
 * No ordering is promised. The marker is written before the copy, so a
 * sibling call that starts after it returns at once and its tool call may
 * run before `types/` has landed.
 */

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { attempt, attemptSync } from "@mimir/plugin-core/result";
import { errMessage, mimirHome } from "@mimir/plugin-core/util";
import { runCommand } from "@mimir/plugin-core/verify";
import { createLogger } from "./logger";

const log = createLogger("worktree-bootstrap");

export const WORKTREES_DIRS = [".claude", "worktrees"] as const;
/** The path segment every Claude Code agent worktree sits under. */
export const WORKTREES_SEGMENT = `${sep}${WORKTREES_DIRS.join(sep)}${sep}`;
const PLUGIN_DIR = ".claude-plugin";
const TYPES = "types";
const STAGING_PREFIX = `.${TYPES}-staging-`;
const GIT = "git";
// Every tracked manifest, the root one included: a leading `**/` in glob
// magic also matches zero directories.
const MANIFEST_PATHSPEC = `:(glob)**/${PLUGIN_DIR}/plugin.json`;
const LS_FILES_ARGS = ["ls-files", "-z", "--", MANIFEST_PATHSPEC] as const;
const LS_FILES_TIMEOUT_MS = 10_000;

/** The worker's worktree root and the coordinator tree it lives under. */
const treesOf = (cwd: string) => {
  const at = cwd.lastIndexOf(WORKTREES_SEGMENT);
  if (at < 0) return null;
  const coordinator = cwd.slice(0, at);
  const name = cwd.slice(at + WORKTREES_SEGMENT.length).split(sep)[0];
  if (!coordinator || !name) return null;
  return {
    coordinator,
    worktree: join(coordinator, ...WORKTREES_DIRS, name),
    name,
  };
};

const markerPath = (name: string) =>
  join(mimirHome(), "agents", `types-${name}.json`);

/** True when `path` is strictly inside `root` (both already resolved). */
const isInside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
};

/** lstat-based existence: a dangling symlink still counts as present. */
const occupied = (path: string) =>
  attemptSync(() => lstatSync(path))[0] === null;

/** Each tracked manifest's `.claude-plugin` folder, relative to the worktree. */
const trackedManifestDirs = async (worktree: string) => {
  // Resolved against the live PATH; spawning a missing executable throws.
  const git = Bun.which(GIT, { PATH: process.env.PATH ?? "" });
  if (!git) return { data: null, error: `${GIT} not found on PATH` };
  const [spawnError, result] = await attempt(() =>
    runCommand([git, ...LS_FILES_ARGS], worktree, LS_FILES_TIMEOUT_MS),
  );
  if (spawnError)
    return { data: null, error: `git ls-files: ${errMessage(spawnError)}` };
  if (result.code !== 0 || result.timedOut)
    return {
      data: null,
      error: `git ls-files exited ${result.code}${result.timedOut ? " (timed out)" : ""}: ${result.stderr.trim()}`,
    };
  const dirs = result.stdout
    .split("\0")
    .filter(Boolean)
    .map((manifest) => dirname(manifest));
  return { data: dirs, error: null };
};

type Roots = {
  readonly coordinator: string;
  readonly coordinatorReal: string;
  readonly worktree: string;
  readonly worktreeReal: string;
};

/** Copy into a private staging folder, then rename it into place. */
const stageAndPlace = (source: string, parent: string, dest: string) => {
  const [stagingError, staging] = attemptSync(() =>
    mkdtempSync(join(parent, STAGING_PREFIX)),
  );
  if (stagingError)
    return { data: null, error: `staging: ${errMessage(stagingError)}` };
  const staged = join(staging, TYPES);
  const [copyError] = attemptSync(() =>
    cpSync(source, staged, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: (path) => !lstatSync(path).isSymbolicLink(),
    }),
  );
  const [renameError] = copyError
    ? [copyError]
    : attemptSync(() => renameSync(staged, dest));
  const [cleanupError] = attemptSync(() =>
    rmSync(staging, { recursive: true, force: true }),
  );
  const cleanup = cleanupError
    ? `; removing ${staging} failed: ${errMessage(cleanupError)}`
    : "";
  if (!renameError) return { data: "copied", error: cleanup || null };
  // Another process's rename won the race: its copy is complete.
  if (!copyError && occupied(dest))
    return { data: "present", error: cleanup || null };
  return { data: null, error: `${errMessage(renameError)}${cleanup}` };
};

/**
 * Copy one `types/`. Both ends are realpath'd and must stay strictly
 * inside their own tree, so neither a `..` in a path nor a symlinked
 * directory can lead the copy out; symlinks inside `types/` are skipped.
 */
const copyTypes = (roots: Roots, manifestDir: string) => {
  const sourceLink = resolve(roots.coordinator, manifestDir, TYPES);
  const parentLink = resolve(roots.worktree, manifestDir);
  if (
    !isInside(roots.coordinator, sourceLink) ||
    !isInside(roots.worktree, parentLink)
  )
    return {
      data: null,
      error: `manifest dir escapes its tree: ${manifestDir}`,
    };
  if (!existsSync(sourceLink)) return { data: "no-source", error: null };
  const [sourceError, source] = attemptSync(() => realpathSync(sourceLink));
  if (sourceError) return { data: null, error: errMessage(sourceError) };
  const [parentError, parent] = attemptSync(() => realpathSync(parentLink));
  if (parentError) return { data: null, error: errMessage(parentError) };
  if (
    !isInside(roots.coordinatorReal, source) ||
    !isInside(roots.worktreeReal, parent)
  )
    return {
      data: null,
      error: `types/ resolves outside its tree: ${manifestDir}`,
    };
  const dest = join(parent, TYPES);
  if (occupied(dest)) return { data: "present", error: null };
  return stageAndPlace(source, parent, dest);
};

/** Lay the coordinator's engine types into a worker worktree, once. */
export const layEngineTypes = async (cwd: string) => {
  const trees = treesOf(cwd);
  if (!trees) return;
  const marker = markerPath(trees.name);
  if (existsSync(marker)) return;
  const [markerError] = await attempt(() =>
    Bun.write(
      marker,
      `${JSON.stringify({ worktree: trees.worktree, at: new Date().toISOString() })}\n`,
    ),
  );
  if (markerError) {
    log.warn("engine types: marker write failed, not copying", {
      marker,
      error: errMessage(markerError),
    });
    return;
  }
  const [rootsError, roots] = attemptSync(() => ({
    coordinator: trees.coordinator,
    coordinatorReal: realpathSync(trees.coordinator),
    worktree: trees.worktree,
    worktreeReal: realpathSync(trees.worktree),
  }));
  if (rootsError) {
    log.warn("engine types: cannot resolve the trees", {
      cwd,
      error: errMessage(rootsError),
    });
    return;
  }
  const dirs = await trackedManifestDirs(roots.worktree);
  if (dirs.error !== null) {
    log.warn("engine types: listing plugin manifests failed", {
      worktree: roots.worktree,
      error: dirs.error,
    });
    return;
  }
  for (const manifestDir of dirs.data) {
    const outcome = copyTypes(roots, manifestDir);
    if (outcome.error !== null)
      log.warn("engine types: copy failed", {
        worktree: roots.worktree,
        manifestDir,
        error: outcome.error,
      });
    if (outcome.data === "copied")
      log.info("engine types copied", {
        worktree: roots.worktree,
        manifestDir,
      });
  }
};
