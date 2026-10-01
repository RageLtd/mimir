import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../shared-config";
import { resolveUserMemoryDb } from "./local-tools-server";

let home = "";
let savedHome: string | undefined;
let savedDb: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mimir-local-tools-"));
  savedHome = process.env.MIMIR_HOME;
  savedDb = process.env.MIMIR_USER_MEMORY_DB;
  process.env.MIMIR_HOME = home;
  delete process.env.MIMIR_USER_MEMORY_DB;
});

afterEach(async () => {
  if (savedHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = savedHome;
  if (savedDb === undefined) delete process.env.MIMIR_USER_MEMORY_DB;
  else process.env.MIMIR_USER_MEMORY_DB = savedDb;
  await rm(home, { recursive: true, force: true });
});

describe("resolveUserMemoryDb", () => {
  test("env wins over everything", async () => {
    process.env.MIMIR_USER_MEMORY_DB = "/env/path.db";
    await writeConfig({ serverUrl: "https://s", userMemoryDb: "/cfg/path.db" });
    expect(await resolveUserMemoryDb()).toBe("/env/path.db");
  });

  test("falls back to the install-time choice in config.json", async () => {
    await writeConfig({ serverUrl: "https://s", userMemoryDb: "/cfg/path.db" });
    expect(await resolveUserMemoryDb()).toBe("/cfg/path.db");
  });

  test("defaults to ~/.mimir/user-memories.db without env or config", async () => {
    expect(await resolveUserMemoryDb()).toBe(join(home, "user-memories.db"));
  });
});
