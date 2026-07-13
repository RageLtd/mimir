/**
 * Tests for the project path → UUID disk cache.
 *
 * Sets `MIMIR_HOME` per test so the cache lands in a temp dir instead of
 * the real `~/.mimir/project-paths.json`. We deliberately do NOT swap
 * `process.env.HOME` — Bun's `homedir()` caches at process start and
 * ignores the override, which means the usual HOME-swap trick silently
 * writes to the developer's real home. The cache module exposes the
 * MIMIR_HOME env knob specifically so tests can sidestep that footgun.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getCachedProjectId,
  readCache,
  readProjectIdAliases,
  setCachedProjectId,
  setProjectIdAlias,
  writeCache,
} from "./cache";

let tmp = "";
const originalMimirHome = process.env.MIMIR_HOME;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mimir-cache-"));
  process.env.MIMIR_HOME = tmp;
});

afterEach(async () => {
  if (originalMimirHome === undefined) {
    delete process.env.MIMIR_HOME;
  } else {
    process.env.MIMIR_HOME = originalMimirHome;
  }
  await rm(tmp, { recursive: true, force: true });
});

describe("readCache", () => {
  test("returns empty object when the file does not exist", async () => {
    expect(await readCache()).toEqual({});
  });

  test("returns empty object when the file contains corrupt JSON", async () => {
    const path = join(tmp, "project-paths.json");
    await Bun.write(path, "{not valid json");
    expect(await readCache()).toEqual({});
  });

  test("returns the parsed map when the file is valid", async () => {
    const path = join(tmp, "project-paths.json");
    await Bun.write(
      path,
      JSON.stringify({ "/repo/a": "uuid-a", "/repo/b": "uuid-b" }),
    );
    expect(await readCache()).toEqual({
      "/repo/a": "uuid-a",
      "/repo/b": "uuid-b",
    });
  });
});

describe("writeCache + readCache round-trip", () => {
  test("persists the full map and reads it back", async () => {
    await writeCache({ "/repo/x": "uuid-x" });
    expect(await readCache()).toEqual({ "/repo/x": "uuid-x" });
  });
});

describe("setCachedProjectId / getCachedProjectId", () => {
  test("getCachedProjectId returns null for an unknown path", async () => {
    expect(await getCachedProjectId("/unknown")).toBeNull();
  });

  test("setCachedProjectId persists a single entry without clobbering others", async () => {
    await writeCache({ "/repo/a": "uuid-a" });
    await setCachedProjectId("/repo/b", "uuid-b");
    expect(await readCache()).toEqual({
      "/repo/a": "uuid-a",
      "/repo/b": "uuid-b",
    });
    expect(await getCachedProjectId("/repo/b")).toBe("uuid-b");
  });

  test("setCachedProjectId overwrites an existing entry for the same path", async () => {
    await setCachedProjectId("/repo/x", "old-uuid");
    await setCachedProjectId("/repo/x", "new-uuid");
    expect(await getCachedProjectId("/repo/x")).toBe("new-uuid");
  });
});

describe("project id aliases", () => {
  test("persists legacy-to-local mappings without clobbering earlier migrations", async () => {
    await setProjectIdAlias("legacy-a", "project:a");
    await setProjectIdAlias("legacy-b", "project:b");
    expect(await readProjectIdAliases()).toEqual({
      "legacy-a": "project:a",
      "legacy-b": "project:b",
    });
  });
});
