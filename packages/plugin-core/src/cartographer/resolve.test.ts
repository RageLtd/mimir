import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "../result";
import { isExecutableFile, resolveCartographerBinary } from "./resolve";

let sandbox: string;
let executablePath: string;
let downloadedPath: string;
let plainFilePath: string;

const neverDownload = async (): Promise<Result<string>> => {
  throw new Error("download must not be called in this scenario");
};

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "mimir-carto-resolve-test-"));
  executablePath = join(sandbox, "cartographer");
  writeFileSync(executablePath, "#!/bin/sh\nexit 0\n");
  chmodSync(executablePath, 0o755);
  downloadedPath = join(sandbox, "mimir-bin", "cartographer");
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
  test("valid explicit path wins and nothing is downloaded", async () => {
    const result = await resolveCartographerBinary({
      requested: executablePath,
      download: neverDownload,
    });
    expect(result).toEqual({ ok: true, binary: executablePath });
  });

  test("invalid explicit path fails loudly", async () => {
    const missing = await resolveCartographerBinary({
      requested: join(sandbox, "typo"),
      download: neverDownload,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("no file at");

    const notExecutable = await resolveCartographerBinary({
      requested: plainFilePath,
      download: neverDownload,
    });
    expect(notExecutable.ok).toBe(false);
    if (!notExecutable.ok) {
      expect(notExecutable.error).toContain("not executable");
    }
  });

  test("no explicit path → the release download decides, whatever is on $PATH", async () => {
    const logged: string[] = [];
    const result = await resolveCartographerBinary({
      download: async (log) => {
        log("downloading");
        return [null, downloadedPath] as const;
      },
      log: (m) => logged.push(m),
    });
    expect(result).toEqual({ ok: true, binary: downloadedPath });
    expect(logged).toEqual(["downloading"]);
  });

  test("a failed download fails the resolution with its reason", async () => {
    const result = await resolveCartographerBinary({
      download: async () => [new Error("HTTP 503"), null] as const,
    });
    expect(result).toEqual({ ok: false, error: "HTTP 503" });
  });
});
