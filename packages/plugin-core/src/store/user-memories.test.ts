import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserMemoryStore } from "./user-memories";

let root: string;
let savedHome: string | undefined;

beforeEach(async () => {
  savedHome = process.env.HOME;
  root = await mkdtemp(join(tmpdir(), "mimir-user-memory-"));
  process.env.HOME = root;
  await mkdir(join(root, ".mimir"), { recursive: true });
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  await rm(root, { recursive: true, force: true });
});

describe("createUserMemoryStore", () => {
  test("opens a home-relative database path without shell expansion", () => {
    const store = createUserMemoryStore("~/.mimir/user-memories.db");
    store.addMemory("home-relative path resolved");

    expect(store.getMemories()[0]?.content).toBe("home-relative path resolved");
    store.close();
  });
});
