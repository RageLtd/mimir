/**
 * Polyglot toolchain resolution — which commands verify a package.
 *
 * The verify gate needs `test` / `check` / `typecheck` for whatever the
 * worker touched, in whatever language. Resolution order, first hit wins:
 *
 *   1. explicit `[verify]` table in the layered `mimir.toml` (user →
 *      project → nested package) — the developer knows their toolchain;
 *      everything below is a fallback
 *   2. task runners — mise, just, make, package.json scripts — if the
 *      project already named a `test` task, run that
 *   3. manifests — Cargo.toml, go.mod, pyproject.toml, package.json, … —
 *      the ecosystem's conventional commands
 *   4. nothing → null. Callers fail closed: an unverifiable "done" is
 *      worth nothing, so silence is the wrong default.
 *
 * Monorepos: `findPackageRoot` walks up from a changed file to the
 * nearest manifest or task-runner file, so each package is verified
 * with its own commands.
 */

import { dirname, join, resolve } from "node:path";
import { createLoggerFactory } from "../logger";
import { hasMimirToml, loadMimirConfig, MIMIR_TOML } from "../mimir-toml";
import { asRecord, parseToml } from "../toml";
import { errMessage } from "../util";
import { hasManifest, manifestCommands } from "./toolchain-manifests";
import type { ResolvedToolchain, VerifyCommands } from "./toolchain-types";

export type {
  ResolvedToolchain,
  ToolchainSource,
  VerifyCommands,
} from "./toolchain-types";

const log = createLoggerFactory("mimir-plugin").createLogger("toolchain");

const COMMAND_KEYS = ["test", "check", "typecheck"] as const;

/** Task names accepted for each command, in preference order. */
const TASK_ALIASES: Record<(typeof COMMAND_KEYS)[number], readonly string[]> = {
  test: ["test"],
  check: ["check", "lint"],
  typecheck: ["typecheck", "type-check", "tsc"],
};

const exists = (filePath: string) => Bun.file(filePath).exists();

const readText = async (filePath: string) => {
  const file = Bun.file(filePath);
  if (!(await file.exists())) return null;
  return file.text().then(
    (text) => text,
    (err) => {
      log.warn("failed to read", { filePath, error: errMessage(err) });
      return null;
    },
  );
};

const isEmpty = (commands: VerifyCommands) =>
  COMMAND_KEYS.every((key) => commands[key] === undefined);

const pickCommands = (record: Record<string, unknown>) => {
  const commands: { -readonly [K in keyof VerifyCommands]: string } = {};
  for (const key of COMMAND_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      commands[key] = value.trim();
    }
  }
  return commands;
};

// ── Layer 1: explicit config ──

const fromConfig = async (root: string, projectRoot: string) => {
  const config = await loadMimirConfig(root, projectRoot);
  const verify = asRecord(config.verify);
  if (!verify) return null;
  const commands = pickCommands(verify);
  if (isEmpty(commands)) return null;
  return {
    root,
    source: "config",
    detail: MIMIR_TOML,
    commands,
  } satisfies ResolvedToolchain;
};

// ── Layer 2: task runners ──

/** Map available task names to commands using the alias table. */
const commandsFromTasks = (
  tasks: ReadonlySet<string>,
  invoke: (task: string) => string,
) => {
  const commands: { -readonly [K in keyof VerifyCommands]: string } = {};
  for (const key of COMMAND_KEYS) {
    const task = TASK_ALIASES[key].find((name) => tasks.has(name));
    if (task) commands[key] = invoke(task);
  }
  return commands;
};

const miseTasks = async (root: string) => {
  for (const name of ["mise.toml", ".mise.toml"]) {
    const text = await readText(join(root, name));
    if (text === null) continue;
    const [parseErr, parsed] = parseToml(text);
    if (parseErr) {
      log.warn("malformed mise.toml", { root, error: errMessage(parseErr) });
      return null;
    }
    const tasks = asRecord(parsed.tasks);
    if (!tasks) return null;
    return { detail: name, tasks: new Set(Object.keys(tasks)) };
  }
  return null;
};

/**
 * Recipe / target names at column 0 — `name:`, `name arg:`, or just's
 * `name arg='default':`. The `(?!=)` lookahead keeps `name := value`
 * assignments out.
 */
const targetNames = (text: string) => {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Za-z_][\w-]*)(?:\s+[^:]*)?:(?!=)/);
    if (match?.[1]) names.add(match[1]);
  }
  return names;
};

const justTasks = async (root: string) => {
  for (const name of ["justfile", "Justfile", ".justfile"]) {
    const text = await readText(join(root, name));
    if (text !== null) return { detail: name, tasks: targetNames(text) };
  }
  return null;
};

const makeTasks = async (root: string) => {
  for (const name of ["Makefile", "makefile", "GNUmakefile"]) {
    const text = await readText(join(root, name));
    if (text !== null) return { detail: name, tasks: targetNames(text) };
  }
  return null;
};

const packageManagerRun = async (root: string, projectRoot: string) => {
  const roots = root === projectRoot ? [root] : [root, projectRoot];
  for (const dir of roots) {
    if (
      (await exists(join(dir, "bun.lock"))) ||
      (await exists(join(dir, "bun.lockb")))
    ) {
      return "bun run";
    }
    if (await exists(join(dir, "pnpm-lock.yaml"))) return "pnpm run";
    if (await exists(join(dir, "yarn.lock"))) return "yarn run";
  }
  return "npm run";
};

const packageScripts = async (root: string) => {
  const text = await readText(join(root, "package.json"));
  if (text === null) return null;
  const parsed = await Promise.resolve()
    .then(() => JSON.parse(text) as unknown)
    .then(asRecord, (err) => {
      log.warn("malformed package.json", { root, error: errMessage(err) });
      return null;
    });
  const scripts = parsed ? asRecord(parsed.scripts) : null;
  if (!scripts) return null;
  return { detail: "package.json", tasks: new Set(Object.keys(scripts)) };
};

const fromTaskRunner = async (root: string, projectRoot: string) => {
  const runners = [
    { find: miseTasks, invoke: (task: string) => `mise run ${task}` },
    { find: justTasks, invoke: (task: string) => `just ${task}` },
    { find: makeTasks, invoke: (task: string) => `make ${task}` },
  ];
  for (const runner of runners) {
    const found = await runner.find(root);
    if (!found) continue;
    const commands = commandsFromTasks(found.tasks, runner.invoke);
    if (isEmpty(commands)) continue;
    return {
      root,
      source: "task-runner",
      detail: found.detail,
      commands,
    } satisfies ResolvedToolchain;
  }

  const scripts = await packageScripts(root);
  if (!scripts) return null;
  const run = await packageManagerRun(root, projectRoot);
  const commands = commandsFromTasks(scripts.tasks, (task) => `${run} ${task}`);
  if (isEmpty(commands)) return null;
  return {
    root,
    source: "task-runner",
    detail: scripts.detail,
    commands,
  } satisfies ResolvedToolchain;
};

// ── Layer 3: manifests ──

const fromManifest = async (root: string, projectRoot: string) => {
  const commands = await manifestCommands(root, projectRoot);
  if (!commands) return null;
  return {
    root,
    source: "manifest",
    detail: "manifest",
    commands,
  } satisfies ResolvedToolchain;
};

// ── Public API ──

/**
 * Resolve verify commands for one package root. `projectRoot` lets the
 * package-manager detection see a monorepo's root lockfile. Null means
 * nothing could be inferred — callers fail closed.
 */
export const resolveToolchain = async (
  root: string,
  projectRoot: string = root,
) =>
  (await fromConfig(root, projectRoot)) ??
  (await fromTaskRunner(root, projectRoot)) ??
  (await fromManifest(root, projectRoot));

const TASK_RUNNER_FILES = [
  "mise.toml",
  ".mise.toml",
  "justfile",
  "Justfile",
  ".justfile",
  "Makefile",
  "makefile",
  "GNUmakefile",
];

const isPackageRoot = async (dir: string) => {
  if (await hasMimirToml(dir)) return true;
  for (const name of TASK_RUNNER_FILES) {
    if (await exists(join(dir, name))) return true;
  }
  return hasManifest(dir);
};

/**
 * Nearest package root at or above `filePath`, never above
 * `projectRoot`. Falls back to `projectRoot` when no marker is found.
 */
export const findPackageRoot = async (
  filePath: string,
  projectRoot: string,
) => {
  const top = resolve(projectRoot);
  let dir = dirname(resolve(top, filePath));
  while (dir.startsWith(top)) {
    if (await isPackageRoot(dir)) return dir;
    if (dir === top) break;
    dir = dirname(dir);
  }
  return top;
};

/**
 * Group changed files by package root and resolve each root once.
 * Roots with no resolvable toolchain map to null so the caller can name
 * them when it fails closed.
 */
export const resolveToolchainsForFiles = async (
  files: readonly string[],
  projectRoot: string,
) => {
  const roots = new Set<string>();
  for (const file of files) roots.add(await findPackageRoot(file, projectRoot));
  const resolved = new Map<string, ResolvedToolchain | null>();
  for (const root of roots) {
    resolved.set(root, await resolveToolchain(root, resolve(projectRoot)));
  }
  return resolved;
};
