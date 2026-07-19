import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isExecutableFile, resolveCartographerBinary } from "./resolve";

let sandbox: string;
let executablePath: string;
let plainFilePath: string;

const neverPrompt = async () => {
  throw new Error("prompt must not be called in this scenario");
};
const noWhich = () => null;
const noFallbacks: readonly string[] = [];

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "mimir-carto-resolve-test-"));
  executablePath = join(sandbox, "cartographer");
  writeFileSync(executablePath, "#!/bin/sh\nexit 0\n");
  chmodSync(executablePath, 0o755);
  plainFilePath = join(sandbox, "notes.txt");
  writeFileSync(plainFilePath, "not a binary");
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("isExecutableFile", () => {
  test("true for an executable regular file", () => {
    expect(isExecutableFile(executablePath)).toBe(true);
  });

  test("false for missing paths, plain files, and directories", () => {
    expect(isExecutableFile(join(sandbox, "missing"))).toBe(false);
    expect(isExecutableFile(plainFilePath)).toBe(false);
    expect(isExecutableFile(sandbox)).toBe(false);
  });
});

describe("resolveCartographerBinary", () => {
  test("valid explicit path wins without touching $PATH or the prompt", async () => {
    const result = await resolveCartographerBinary({
      requested: executablePath,
      which: () => {
        throw new Error("which must not be called for explicit paths");
      },
      promptForPath: neverPrompt,
    });
    expect(result).toEqual({ ok: true, binary: executablePath });
  });

  test("invalid explicit path fails loudly", async () => {
    const missing = await resolveCartographerBinary({
      requested: join(sandbox, "typo"),
      promptForPath: neverPrompt,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("no file at");

    const notExecutable = await resolveCartographerBinary({
      requested: plainFilePath,
      promptForPath: neverPrompt,
    });
    expect(notExecutable.ok).toBe(false);
    if (!notExecutable.ok) {
      expect(notExecutable.error).toContain("not executable");
    }
  });

  test("auto-detects from $PATH when no path requested", async () => {
    const result = await resolveCartographerBinary({
      which: () => executablePath,
      promptForPath: neverPrompt,
    });
    expect(result).toEqual({ ok: true, binary: executablePath });
  });

  test("auto-detects from a well-known path when $PATH is incomplete", async () => {
    const result = await resolveCartographerBinary({
      which: noWhich,
      fallbackPaths: [executablePath],
      promptForPath: neverPrompt,
    });
    expect(result).toEqual({ ok: true, binary: executablePath });
  });

  test("stale $PATH hit falls through to the prompt instead of erroring", async () => {
    const result = await resolveCartographerBinary({
      which: () => join(sandbox, "broken-shim"),
      fallbackPaths: noFallbacks,
      promptForPath: async () => executablePath,
    });
    expect(result).toEqual({ ok: true, binary: executablePath });
  });

  test("prompted path is validated — garbage fails loudly", async () => {
    const result = await resolveCartographerBinary({
      which: noWhich,
      fallbackPaths: noFallbacks,
      promptForPath: async () => join(sandbox, "fat-fingered"),
    });
    expect(result.ok).toBe(false);
  });

  test("blank prompt answer disables indexing explicitly", async () => {
    const result = await resolveCartographerBinary({
      which: noWhich,
      fallbackPaths: noFallbacks,
      promptForPath: async () => null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.binary).toBeNull();
      if (result.binary === null) {
        expect(result.reason).toContain("disabled");
      }
    }
  });
});
