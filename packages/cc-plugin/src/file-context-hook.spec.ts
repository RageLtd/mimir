import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mimirHome } from "@mimir/plugin-core/util";

import { claimInjection, countMemories } from "./file-context-hook";

const HASH = "hash-1";
const EDITED = "hash-2";
const PARALLEL = 20;
const ROUNDS = 5;

const freshSession = () => `sess-${crypto.randomUUID()}`;
const pathsOf = (count: number) =>
  Array.from({ length: count }, (_, i) => `src/file-${i}.ts`);

describe("claimInjection", () => {
  test("a first claim injects; the same path and hash again does not", async () => {
    const session = freshSession();
    expect(await claimInjection(session, "src/a.ts", HASH)).toBe(true);
    expect(await claimInjection(session, "src/a.ts", HASH)).toBe(false);
  });

  test("concurrent claims for different files all stay recorded", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const session = freshSession();
      const paths = pathsOf(PARALLEL);

      const first = await Promise.all(
        paths.map((path) => claimInjection(session, path, HASH)),
      );
      const again = await Promise.all(
        paths.map((path) => claimInjection(session, path, HASH)),
      );

      expect(first).toEqual(paths.map(() => true));
      expect(again).toEqual(paths.map(() => false));
    }
  });

  test("concurrent claims for the same path and hash: exactly one injects", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const session = freshSession();
      const claims = await Promise.all(
        pathsOf(PARALLEL).map(() => claimInjection(session, "src/a.ts", HASH)),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
    }
  });

  test("a changed hash for a recorded path injects again", async () => {
    const session = freshSession();
    expect(await claimInjection(session, "src/a.ts", HASH)).toBe(true);
    expect(await claimInjection(session, "src/a.ts", EDITED)).toBe(true);
    expect(await claimInjection(session, "src/a.ts", EDITED)).toBe(false);
    expect(await claimInjection(session, "src/a.ts", HASH)).toBe(true);
  });

  test("corrupt state reads as not recorded, is repaired by the next claim, and never throws", async () => {
    const session = freshSession();
    expect(await claimInjection(session, "src/a.ts", HASH)).toBe(true);

    // Layout-agnostic: garble every file the state directory holds.
    const stateDir = join(mimirHome(), "file-context-state");
    const files = await Array.fromAsync(
      new Bun.Glob("**/*").scan({ cwd: stateDir, onlyFiles: true }),
    );
    expect(files.length).toBeGreaterThan(0);
    await Promise.all(
      files.map((file) => Bun.write(join(stateDir, file), "{not json")),
    );

    expect(await claimInjection(session, "src/a.ts", HASH)).toBe(true);
    expect(await claimInjection(session, "src/a.ts", HASH)).toBe(false);
  });
});

describe("countMemories", () => {
  test("prefers the server's memoryCount when present", () => {
    expect(
      countMemories({ memoryCount: 3, memories: "- a\nline two\n- b" }),
    ).toBe(3);
  });

  test("memoryCount of 0 wins over a non-empty memories string", () => {
    expect(countMemories({ memoryCount: 0, memories: "- stale" })).toBe(0);
  });

  test("older servers: counts top-level bullets, not lines", () => {
    // Two memories, one with a multi-line body — the old line count
    // reported 13/23/36 "memories" for 3-memory payloads.
    const memories =
      "- first memory\ncontinuation line one\ncontinuation line two\n- second memory";
    expect(countMemories({ memories })).toBe(2);
  });

  test("no memories at all is zero", () => {
    expect(countMemories({})).toBe(0);
    expect(countMemories({ memories: null })).toBe(0);
    expect(countMemories({ memories: "" })).toBe(0);
  });
});
