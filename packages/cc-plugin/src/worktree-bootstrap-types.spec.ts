import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRunner } from "@mimir/plugin-core/verify";
import { bootstrapWorktree } from "./worktree-bootstrap";

// The engine lays these into `<plugin dir>/.claude-plugin/types/` when a
// plugin is loaded interactively; the folder ignores itself, so a fresh
// worker worktree never has it.
const PLUGIN_DIR = ".claude-plugin";
const TYPES = "types";
const MANIFEST = "plugin.json";
const DECL = "hooks.d.ts";
const NESTED_DECL = join("engine", "runtime.d.ts");
const IGNORE = ".gitignore";
const IGNORE_BODY = "*\n";
const NESTED_PKG = join("packages", "x");
const OTHER_PKG = join("packages", "y");

let previousMimirHome: string | undefined;
let home: string;
let root: string;

beforeAll(() => {
  previousMimirHome = process.env.MIMIR_HOME;
  home = mkdtempSync(join(tmpdir(), "mimir-bootstrap-types-home-"));
  mkdirSync(join(home, "agents"), { recursive: true });
  process.env.MIMIR_HOME = home;
  root = mkdtempSync(join(tmpdir(), "mimir-bootstrap-types-"));
});

afterAll(() => {
  if (previousMimirHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = previousMimirHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${cwd}: ${result.stderr.toString()}`,
    );
  }
};

/** Each test gets its own coordinator tree so laid-out types never leak. */
const coordinatorTree = (name: string) => {
  const dir = join(root, name, "repo");
  mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * A worker worktree under the coordinator tree, a git repository whose
 * index tracks a plugin manifest in each of `pluginDirs` ("" = root).
 */
const workerTree = async (
  coordinator: string,
  agent: string,
  pluginDirs: readonly string[],
) => {
  const wt = join(coordinator, ".claude", "worktrees", agent);
  mkdirSync(wt, { recursive: true });
  git(wt, "init", "--quiet");
  for (const dir of pluginDirs) {
    await Bun.write(join(wt, dir, PLUGIN_DIR, MANIFEST), "{}\n");
    git(wt, "add", join(dir, PLUGIN_DIR, MANIFEST));
  }
  return wt;
};

/** The engine-laid declarations in the coordinator's tree. */
const layTypes = async (tree: string, dir: string, tag: string) => {
  const types = join(tree, dir, PLUGIN_DIR, TYPES);
  await Bun.write(join(types, DECL), `// ${tag}\n`);
  await Bun.write(join(types, NESTED_DECL), `// nested ${tag}\n`);
  await Bun.write(join(types, IGNORE), IGNORE_BODY);
  return types;
};

const typesIn = (tree: string, dir: string) =>
  join(tree, dir, PLUGIN_DIR, TYPES);

const read = (path: string) => readFileSync(path, "utf8");

const runner = (code: number, seen: string[][] = []): CommandRunner => {
  return async (argv, cwd) => {
    seen.push([...argv, cwd]);
    return { code, stdout: "", stderr: "", timedOut: false };
  };
};

const expectCopied = (wt: string, dir: string, tag: string) => {
  const types = typesIn(wt, dir);
  expect(read(join(types, DECL))).toBe(`// ${tag}\n`);
  expect(read(join(types, NESTED_DECL))).toBe(`// nested ${tag}\n`);
  expect(read(join(types, IGNORE))).toBe(IGNORE_BODY);
};

// Enough declarations that a racing bootstrap cleaning up after itself
// would visibly remove something.
const EXTRA_DECLS = Array.from({ length: 20 }, (_, i) => `extra-${i}.d.ts`);

const layManyTypes = async (tree: string, tag: string) => {
  const types = await layTypes(tree, "", tag);
  for (const name of EXTRA_DECLS) {
    await Bun.write(join(types, name), `// ${name} ${tag}\n`);
  }
  return types;
};

const expectAllCopied = (wt: string, tag: string) => {
  expectCopied(wt, "", tag);
  for (const name of EXTRA_DECLS) {
    expect(read(join(typesIn(wt, ""), name))).toBe(`// ${name} ${tag}\n`);
  }
};

const expectOnlyManifestAndTypes = (wt: string) => {
  expect(readdirSync(join(wt, PLUGIN_DIR)).sort()).toEqual(
    [MANIFEST, TYPES].sort(),
  );
};

const concurrently = (wt: string, n: number) =>
  Promise.all(
    Array.from({ length: n }, () => bootstrapWorktree(wt, runner(0))),
  );

// In production each of a worker's parallel first tool calls bootstraps in
// its own process; calls in one process never interleave, so only separate
// processes exercise the race.
const BOOTSTRAP_MODULE = join(import.meta.dir, "worktree-bootstrap.ts");
const PROCESS_RACERS = 8;
const PROCESS_ROUNDS = 5;

const childScript = (wt: string) => `
import { bootstrapWorktree } from ${JSON.stringify(BOOTSTRAP_MODULE)};
const ok = async () => ({ code: 0, stdout: "", stderr: "", timedOut: false });
await bootstrapWorktree(${JSON.stringify(wt)}, ok);
process.exit(0);
`;

const racingProcesses = async (wt: string, n: number) => {
  const children = Array.from({ length: n }, () =>
    Bun.spawn([process.execPath, "-e", childScript(wt)], {
      env: { ...process.env, MIMIR_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  return Promise.all(
    children.map(async (child) => ({
      code: await child.exited,
      stderr: await new Response(child.stderr).text(),
    })),
  );
};

describe("bootstrapWorktree lays the engine's type declarations", () => {
  test("copies types/ for a root manifest, with nested files and its .gitignore", async () => {
    const coord = coordinatorTree("root-manifest");
    await layTypes(coord, "", "root");
    const wt = await workerTree(coord, "agent-root", [""]);
    await bootstrapWorktree(wt, runner(0));
    expectCopied(wt, "", "root");
  });

  test("of two nested manifests, copies only the one whose types/ exists in the coordinator's tree", async () => {
    const coord = coordinatorTree("two-manifests");
    await layTypes(coord, NESTED_PKG, "x");
    const wt = await workerTree(coord, "agent-two", [NESTED_PKG, OTHER_PKG]);
    await bootstrapWorktree(wt, runner(0));
    expectCopied(wt, NESTED_PKG, "x");
    expect(existsSync(typesIn(wt, OTHER_PKG))).toBe(false);
  });

  test("never overwrites a types/ folder the worker already has", async () => {
    const coord = coordinatorTree("no-overwrite");
    await layTypes(coord, "", "coordinator");
    const wt = await workerTree(coord, "agent-keep", [""]);
    const own = join(typesIn(wt, ""), DECL);
    await Bun.write(own, "// worker's own\n");
    await bootstrapWorktree(wt, runner(0));
    expect(read(own)).toBe("// worker's own\n");
    expect(existsSync(join(typesIn(wt, ""), NESTED_DECL))).toBe(false);
    expect(existsSync(join(typesIn(wt, ""), IGNORE))).toBe(false);
  });

  test("copies when there is no bun.lock (nothing to install)", async () => {
    const coord = coordinatorTree("no-lock");
    await layTypes(coord, "", "nolock");
    const wt = await workerTree(coord, "agent-nolock-types", [""]);
    const seen: string[][] = [];
    expect(await bootstrapWorktree(wt, runner(0, seen))).toBe("ready");
    expect(seen).toEqual([]);
    expectCopied(wt, "", "nolock");
  });

  test("copies when node_modules is already present", async () => {
    const coord = coordinatorTree("warm");
    await layTypes(coord, "", "warm");
    const wt = await workerTree(coord, "agent-warm-types", [""]);
    await Bun.write(join(wt, "bun.lock"), "");
    mkdirSync(join(wt, "node_modules"), { recursive: true });
    const seen: string[][] = [];
    expect(await bootstrapWorktree(wt, runner(0, seen))).toBe("ready");
    expect(seen).toEqual([]);
    expectCopied(wt, "", "warm");
  });

  test("copies when an install runs, and the install still reports", async () => {
    const coord = coordinatorTree("install");
    await layTypes(coord, "", "install");
    const wt = await workerTree(coord, "agent-install-types", [""]);
    await Bun.write(join(wt, "bun.lock"), "");
    const seen: string[][] = [];
    expect(await bootstrapWorktree(wt, runner(0, seen))).toBe("installed");
    expect(seen).toEqual([["bun", "install", "--frozen-lockfile", wt]]);
    expectCopied(wt, "", "install");
  });

  test("copies once per worktree: a removed types/ is not re-created", async () => {
    const coord = coordinatorTree("once");
    await layTypes(coord, "", "once");
    const wt = await workerTree(coord, "agent-once-types", [""]);
    await bootstrapWorktree(wt, runner(0));
    expectCopied(wt, "", "once");
    rmSync(typesIn(wt, ""), { recursive: true, force: true });
    await bootstrapWorktree(wt, runner(0));
    expect(existsSync(typesIn(wt, ""))).toBe(false);
  });

  test("outside a worker worktree nothing is copied", async () => {
    const coord = coordinatorTree("not-worktree");
    await layTypes(coord, "", "elsewhere");
    // A plain checkout beside the coordinator, with a tracked manifest.
    const plain = join(root, "not-worktree", "plain");
    mkdirSync(plain, { recursive: true });
    git(plain, "init", "--quiet");
    await Bun.write(join(plain, PLUGIN_DIR, MANIFEST), "{}\n");
    git(plain, "add", join(PLUGIN_DIR, MANIFEST));
    expect(await bootstrapWorktree(plain, runner(0))).toBe("not-a-worktree");
    expect(existsSync(typesIn(plain, ""))).toBe(false);
  });

  test("nothing is copied when the coordinator's tree has no types/", async () => {
    const coord = coordinatorTree("no-source");
    const wt = await workerTree(coord, "agent-nosource", [""]);
    expect(await bootstrapWorktree(wt, runner(0))).toBe("ready");
    expect(existsSync(typesIn(wt, ""))).toBe(false);
  });

  test("an unreadable source does not throw or change the install outcome", async () => {
    const coord = coordinatorTree("unreadable");
    const source = await layTypes(coord, "", "unreadable");
    const wt = await workerTree(coord, "agent-unreadable", [""]);
    await Bun.write(join(wt, "bun.lock"), "");
    chmodSync(source, 0o000);
    try {
      expect(await bootstrapWorktree(wt, runner(0))).toBe("installed");
    } finally {
      chmodSync(source, 0o755);
    }
  });

  test("an unwritable destination does not throw or change the install outcome", async () => {
    const coord = coordinatorTree("unwritable");
    await layTypes(coord, "", "unwritable");
    const wt = await workerTree(coord, "agent-unwritable", [""]);
    await Bun.write(join(wt, "bun.lock"), "");
    const dest = join(wt, PLUGIN_DIR);
    chmodSync(dest, 0o555);
    try {
      expect(await bootstrapWorktree(wt, runner(1))).toBe("failed");
    } finally {
      chmodSync(dest, 0o755);
    }
    expect(existsSync(typesIn(wt, ""))).toBe(false);
  });

  test("two concurrent first bootstraps leave a complete copy", async () => {
    const coord = coordinatorTree("race-two");
    await layManyTypes(coord, "race2");
    const wt = await workerTree(coord, "agent-race-two", [""]);
    await concurrently(wt, 2);
    expectAllCopied(wt, "race2");
  });

  test("four concurrent first bootstraps leave a complete copy", async () => {
    const coord = coordinatorTree("race-four");
    await layManyTypes(coord, "race4");
    const wt = await workerTree(coord, "agent-race-four", [""]);
    await concurrently(wt, 4);
    expectAllCopied(wt, "race4");
  });

  test("concurrent bootstraps leave nothing beside the manifest but types/", async () => {
    const coord = coordinatorTree("race-leftovers");
    await layManyTypes(coord, "leftovers");
    const wt = await workerTree(coord, "agent-race-leftovers", [""]);
    await concurrently(wt, 3);
    expectOnlyManifestAndTypes(wt);
  });

  test("first bootstraps racing in separate processes leave one complete copy and no leftovers", async () => {
    for (let round = 0; round < PROCESS_ROUNDS; round++) {
      const tag = `procs${round}`;
      const coord = coordinatorTree(`race-procs-${round}`);
      await layManyTypes(coord, tag);
      const wt = await workerTree(coord, `agent-race-procs-${round}`, [""]);
      const results = await racingProcesses(wt, PROCESS_RACERS);
      // Failed children are listed with their stderr, so a broken child
      // script reads differently from a missing copy.
      expect(results).toHaveLength(PROCESS_RACERS);
      expect(results.filter((r) => r.code !== 0)).toEqual([]);
      expectAllCopied(wt, tag);
      expectOnlyManifestAndTypes(wt);
    }
  }, 30_000);

  test("a copy that fails part-way leaves no types/ in the worker's tree", async () => {
    const coord = coordinatorTree("partial");
    const source = await layManyTypes(coord, "partial");
    const wt = await workerTree(coord, "agent-partial", [""]);
    await Bun.write(join(wt, "bun.lock"), "");
    const locked = join(source, EXTRA_DECLS[10] ?? DECL);
    chmodSync(locked, 0o000);
    try {
      expect(await bootstrapWorktree(wt, runner(0))).toBe("installed");
    } finally {
      chmodSync(locked, 0o644);
    }
    expect(existsSync(typesIn(wt, ""))).toBe(false);
  });

  test("a git that cannot be started does not throw or change the install outcome", async () => {
    const coord = coordinatorTree("no-git");
    await layTypes(coord, "", "nogit");
    const wt = await workerTree(coord, "agent-no-git", [""]);
    await Bun.write(join(wt, "bun.lock"), "");
    const emptyBin = mkdtempSync(join(root, "empty-bin-"));
    const previousPath = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      expect(await bootstrapWorktree(wt, runner(0))).toBe("installed");
    } finally {
      process.env.PATH = previousPath;
    }
    expect(existsSync(typesIn(wt, ""))).toBe(false);
  });
});
