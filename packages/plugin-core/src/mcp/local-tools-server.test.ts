import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../shared-config";
import {
  resolveSearchProjectId,
  resolveUserMemoryDb,
} from "./local-tools-server";

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

describe("resolveSearchProjectId", () => {
  const GIVEN_PROJECT = "project:abc";
  const CWD_PROJECT = "project:from-cwd";

  /** A resolveFromCwd that records each call and resolves `value`. */
  const counting = (value: string | null | undefined) => {
    const calls = { count: 0 };
    const resolve = async () => {
      calls.count += 1;
      return value;
    };
    return { calls, resolve };
  };

  test("a given project string is returned unchanged, cwd not consulted", async () => {
    const { calls, resolve } = counting(CWD_PROJECT);
    expect(await resolveSearchProjectId(GIVEN_PROJECT, resolve)).toBe(
      GIVEN_PROJECT,
    );
    expect(calls.count).toBe(0);
  });

  test("a path-like string is returned unchanged, never resolved", async () => {
    const pathLike = "/some/abs/path";
    const { calls, resolve } = counting(CWD_PROJECT);
    expect(await resolveSearchProjectId(pathLike, resolve)).toBe(pathLike);
    expect(calls.count).toBe(0);
  });

  test("undefined resolves the cwd project once", async () => {
    const { calls, resolve } = counting(CWD_PROJECT);
    expect(await resolveSearchProjectId(undefined, resolve)).toBe(CWD_PROJECT);
    expect(calls.count).toBe(1);
  });

  test.each([
    { label: "null", value: null },
    { label: "undefined", value: undefined },
  ])("undefined with a cwd resolving $label gives undefined", async ({
    value,
  }) => {
    const { resolve } = counting(value);
    expect(await resolveSearchProjectId(undefined, resolve)).toBeUndefined();
  });

  test("undefined with a rejecting cwd resolver gives undefined, no throw", async () => {
    const rejecting = async () => {
      throw new Error("cwd is not a project");
    };
    expect(await resolveSearchProjectId(undefined, rejecting)).toBeUndefined();
  });
});
