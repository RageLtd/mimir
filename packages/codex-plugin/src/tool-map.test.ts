import { describe, expect, test } from "bun:test";
import {
  editedFilePaths,
  normalizeToolCalls,
  parsePatchOps,
  readFilePath,
} from "./tool-map";

const MULTI_FILE_PATCH = [
  "*** Begin Patch",
  "*** Update File: /repo/src/a.ts",
  "@@",
  " context",
  "+added",
  "*** Add File: /repo/src/b.ts",
  "+export const b = 1;",
  "*** Delete File: /repo/src/c.ts",
  "*** End Patch",
].join("\n");

// Captured verbatim from the 0.144.0 spike (hook-payloads.jsonl).
const SPIKE_PATCH =
  "*** Begin Patch\n*** Update File: /tmp/mimir-codex-spike/project/greet.ts\n@@\n export const farewell = (name: string) => `Goodbye, ${name}!`;\n+\n+export const shout = (name: string) => `HELLO, ${name.toUpperCase()}!`;\n*** End Patch";

describe("parsePatchOps", () => {
  test("extracts every header from a multi-file patch", () => {
    expect(parsePatchOps(MULTI_FILE_PATCH)).toEqual([
      { kind: "update", path: "/repo/src/a.ts" },
      { kind: "add", path: "/repo/src/b.ts" },
      { kind: "delete", path: "/repo/src/c.ts" },
    ]);
  });

  test("parses the real spike payload", () => {
    expect(parsePatchOps(SPIKE_PATCH)).toEqual([
      { kind: "update", path: "/tmp/mimir-codex-spike/project/greet.ts" },
    ]);
  });

  test("hunk lines never match as headers", () => {
    const patch = "*** Begin Patch\n@@\n+*** Update File: not-really\n";
    // The added line starts with '+', not '*** ', so nothing matches.
    expect(parsePatchOps(patch)).toEqual([]);
  });
});

describe("normalizeToolCalls", () => {
  test("apply_patch fans out to Edit/Write per touched file", () => {
    const calls = normalizeToolCalls("apply_patch", {
      command: MULTI_FILE_PATCH,
    });
    expect(calls).toEqual([
      { toolName: "Edit", toolInput: { file_path: "/repo/src/a.ts" } },
      { toolName: "Write", toolInput: { file_path: "/repo/src/b.ts" } },
    ]);
  });

  test("Bash passes through unchanged", () => {
    const calls = normalizeToolCalls("Bash", { command: "ls -la" });
    expect(calls).toEqual([
      { toolName: "Bash", toolInput: { command: "ls -la" } },
    ]);
  });

  test("apply_patch without a command yields nothing", () => {
    expect(normalizeToolCalls("apply_patch", {})).toEqual([]);
  });
});

describe("editedFilePaths", () => {
  test("returns written paths, skipping deletes", () => {
    expect(editedFilePaths("apply_patch", { command: MULTI_FILE_PATCH })).toEqual(
      ["/repo/src/a.ts", "/repo/src/b.ts"],
    );
  });

  test("non-edit tools contribute nothing", () => {
    expect(editedFilePaths("Bash", { command: "rm -rf /repo" })).toEqual([]);
  });
});

describe("readFilePath", () => {
  test("matches Codex's sed read idiom from the spike", () => {
    expect(
      readFilePath("Bash", { command: "sed -n '1,240p' greet.ts" }),
    ).toBe("greet.ts");
  });

  test("matches simple cat / head / tail", () => {
    expect(readFilePath("Bash", { command: "cat src/index.ts" })).toBe(
      "src/index.ts",
    );
    expect(readFilePath("Bash", { command: "head -50 README.md" })).toBe(
      "README.md",
    );
    expect(readFilePath("Bash", { command: "tail -n 20 log.txt" })).toBe(
      "log.txt",
    );
  });

  test("rejects compound and non-read commands", () => {
    expect(readFilePath("Bash", { command: "cat a.ts | grep foo" })).toBeNull();
    expect(readFilePath("Bash", { command: "cd x && cat a.ts" })).toBeNull();
    expect(readFilePath("Bash", { command: "ls -la" })).toBeNull();
    expect(readFilePath("apply_patch", { command: "cat a.ts" })).toBeNull();
  });
});
