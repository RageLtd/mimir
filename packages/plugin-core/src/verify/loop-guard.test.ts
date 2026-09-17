import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearBlocks, MAX_BLOCKS, noteBlock, readBlocks } from "./loop-guard";

const dirs: string[] = [];
const savedHome = process.env.MIMIR_HOME;

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "mimir-loop-"));
  dirs.push(home);
  process.env.MIMIR_HOME = home;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = savedHome;
});

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("loop guard", () => {
  test("counts blocks per agent and clears", async () => {
    expect(await readBlocks("a")).toBe(0);
    expect(await noteBlock("a")).toBe(1);
    expect(await noteBlock("a")).toBe(2);
    expect(await noteBlock("b")).toBe(1);
    expect(await readBlocks("a")).toBe(2);
    await clearBlocks("a");
    expect(await readBlocks("a")).toBe(0);
    expect(await readBlocks("b")).toBe(1);
  });

  test("MAX_BLOCKS is three", () => {
    expect(MAX_BLOCKS).toBe(3);
  });
});
