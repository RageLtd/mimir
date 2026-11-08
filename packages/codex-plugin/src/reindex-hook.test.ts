import { describe, expect, test } from "bun:test";
import { reindexTargets } from "./reindex-hook";
import { APPLY_PATCH_TOOL } from "./tool-map";

const ROOT = "/work/repo";
const IN_ROOT = "/work/repo/src/a.ts";
const OUTSIDE = "/private/tmp/scratch/notes.txt";
const DRIFTED_CWD = "/work/repo/packages/x";
const RELATIVE_HEADER = "src/a.ts";

const patchOf = (...lines: readonly string[]) =>
  ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");

const updateFile = (path: string) => [
  `*** Update File: ${path}`,
  "@@",
  "-old",
  "+new",
];

const addFile = (path: string) => [`*** Add File: ${path}`, "+hello"];

const applyPatch = (patch: string) => ({
  tool_name: APPLY_PATCH_TOOL,
  tool_input: { command: patch },
});

const skipReason = (result: ReturnType<typeof reindexTargets>) => {
  if (!("skip" in result)) {
    throw new Error(`expected a skip, got ${JSON.stringify(result)}`);
  }
  return result.skip;
};

describe("reindexTargets", () => {
  test("accepts a single in-root path", () => {
    const result = reindexTargets(
      applyPatch(patchOf(...updateFile(IN_ROOT))),
      ROOT,
    );
    expect(result).toEqual({
      projectPath: ROOT,
      filePaths: [IN_ROOT],
      skipped: [],
    });
  });

  test("keeps in-root paths and skips outside ones, naming the root", () => {
    const result = reindexTargets(
      applyPatch(patchOf(...updateFile(IN_ROOT), ...addFile(OUTSIDE))),
      ROOT,
    );
    if ("skip" in result) {
      throw new Error(`expected targets, got ${JSON.stringify(result)}`);
    }
    expect(result.filePaths).toEqual([IN_ROOT]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.filePath).toBe(OUTSIDE);
    expect(result.skipped[0]?.reason).toContain(ROOT);
  });

  test("skips every write when there is no repository root", () => {
    const result = reindexTargets(
      applyPatch(patchOf(...updateFile(IN_ROOT))),
      null,
    );
    expect(skipReason(result)).toContain("repository");
  });

  test("skips a tool that is not apply_patch, naming the tool", () => {
    const result = reindexTargets(
      { tool_name: "Bash", tool_input: { command: `cat ${IN_ROOT}` } },
      ROOT,
    );
    expect(skipReason(result)).toContain("Bash");
  });

  test("skips a patch that only deletes a file", () => {
    const result = reindexTargets(
      applyPatch(patchOf(`*** Delete File: ${IN_ROOT}`)),
      ROOT,
    );
    expect(skipReason(result)).toContain("file");
  });

  test("skips a payload with no tool name", () => {
    const result = reindexTargets({ tool_input: { command: "x" } }, ROOT);
    expect("skip" in result).toBe(true);
  });

  test("resolves a relative header against the payload cwd", () => {
    const result = reindexTargets(
      {
        ...applyPatch(patchOf(...updateFile(RELATIVE_HEADER))),
        cwd: DRIFTED_CWD,
      },
      ROOT,
    );
    expect(result).toEqual({
      projectPath: ROOT,
      filePaths: [`${DRIFTED_CWD}/${RELATIVE_HEADER}`],
      skipped: [],
    });
  });

  test("skips a relative header that resolves outside the root", () => {
    const result = reindexTargets(
      {
        ...applyPatch(patchOf(...updateFile("../../../outside.ts"))),
        cwd: DRIFTED_CWD,
      },
      ROOT,
    );
    if ("skip" in result) {
      throw new Error(`expected targets, got ${JSON.stringify(result)}`);
    }
    expect(result.filePaths).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.filePath).toBe("/work/outside.ts");
    expect(result.skipped[0]?.reason).toContain(ROOT);
  });

  test("resolves a relative header against the root when cwd is absent", () => {
    const result = reindexTargets(
      applyPatch(patchOf(...updateFile(RELATIVE_HEADER))),
      ROOT,
    );
    if ("skip" in result) {
      throw new Error(`expected targets, got ${JSON.stringify(result)}`);
    }
    expect(result.filePaths).toEqual([IN_ROOT]);
  });
});
