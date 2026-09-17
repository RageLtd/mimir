import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { configLayerPaths, loadMimirConfig, mergeConfig } from "./mimir-toml";

const dirs: string[] = [];

const mkTmp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "mimir-toml-"));
  dirs.push(dir);
  return dir;
};

const write = async (dir: string, name: string, content: string) => {
  const filePath = join(dir, name);
  await mkdir(dirname(filePath), { recursive: true });
  await Bun.write(filePath, content);
};

const savedHome = process.env.MIMIR_HOME;
let home = "";

beforeEach(async () => {
  home = await mkTmp();
  process.env.MIMIR_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = savedHome;
});

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("configLayerPaths", () => {
  test("user, project, then each directory down to the package", async () => {
    const root = await mkTmp();
    expect(configLayerPaths(join(root, "packages/api"), root)).toEqual([
      join(home, "mimir.toml"),
      join(root, "mimir.toml"),
      join(root, "packages/mimir.toml"),
      join(root, "packages/api/mimir.toml"),
    ]);
  });

  test("dir at the project root → user + project only", async () => {
    const root = await mkTmp();
    expect(configLayerPaths(root, root)).toEqual([
      join(home, "mimir.toml"),
      join(root, "mimir.toml"),
    ]);
  });

  test("dir outside the project never walks above the root", async () => {
    const root = await mkTmp();
    expect(configLayerPaths(dirname(root), root)).toHaveLength(2);
  });
});

describe("mergeConfig", () => {
  test("tables merge key-by-key; scalars and arrays replace", () => {
    const merged = mergeConfig(
      { verify: { test: "a", check: "b" }, list: [1, 2], n: 1 },
      { verify: { test: "c" }, list: [3], m: 2 },
    );
    expect(merged).toEqual({
      verify: { test: "c", check: "b" },
      list: [3],
      n: 1,
      m: 2,
    });
  });

  test("a scalar overriding a table replaces it wholesale", () => {
    expect(mergeConfig({ x: { a: 1 } }, { x: "flat" })).toEqual({ x: "flat" });
  });
});

describe("loadMimirConfig", () => {
  test("deeper layers win, shallower keys survive", async () => {
    const root = await mkTmp();
    await write(
      home,
      "mimir.toml",
      '[verify]\ncheck = "user-check"\n[agents]\nimpl = "haiku"\n',
    );
    await write(
      root,
      "mimir.toml",
      '[verify]\ntest = "root-test"\ncheck = "root-check"\n',
    );
    await write(
      root,
      "packages/api/mimir.toml",
      '[verify]\ntest = "api-test"\n',
    );

    expect(await loadMimirConfig(join(root, "packages/api"), root)).toEqual({
      verify: { test: "api-test", check: "root-check" },
      agents: { impl: "haiku" },
    });
    expect(await loadMimirConfig(root, root)).toEqual({
      verify: { test: "root-test", check: "root-check" },
      agents: { impl: "haiku" },
    });
  });

  test("no files anywhere → empty record", async () => {
    const root = await mkTmp();
    expect(await loadMimirConfig(root, root)).toEqual({});
  });

  test("a malformed layer is skipped, the others still apply", async () => {
    const root = await mkTmp();
    await write(root, "mimir.toml", "[verify\nbroken = = =\n");
    await write(root, "pkg/mimir.toml", '[verify]\ntest = "ok"\n');
    expect(await loadMimirConfig(join(root, "pkg"), root)).toEqual({
      verify: { test: "ok" },
    });
  });
});
