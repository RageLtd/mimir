import { describe, expect, test } from "bun:test";
import { reindexTarget } from "./reindex-hook";

const ROOT = "/work/repo";
const IN_ROOT = "/work/repo/packages/x/src/a.ts";

const skipReason = (result: ReturnType<typeof reindexTarget>) => {
  if (!("skip" in result)) {
    throw new Error(`expected a skip, got ${JSON.stringify(result)}`);
  }
  return result.skip;
};

describe("reindexTarget", () => {
  test("accepts an in-root absolute path unchanged", () => {
    const result = reindexTarget(
      { tool_name: "Edit", tool_input: { file_path: IN_ROOT } },
      ROOT,
    );
    expect(result).toEqual({ projectPath: ROOT, filePath: IN_ROOT });
  });

  test("skips a write outside the project root, naming the root", () => {
    const result = reindexTarget(
      {
        tool_name: "Write",
        tool_input: { file_path: "/private/tmp/scratch/notes.txt" },
      },
      ROOT,
    );
    expect(skipReason(result)).toContain(ROOT);
  });

  test("skips every write when there is no repository root", () => {
    const result = reindexTarget(
      {
        tool_name: "Edit",
        tool_input: { file_path: "/private/tmp/scratch/notes.txt" },
      },
      null,
    );
    expect(skipReason(result)).toContain("repository");
  });

  test("skips a path that leaves the root through ..", () => {
    const result = reindexTarget(
      { tool_name: "Write", tool_input: { file_path: "/work/repo/../etc/x" } },
      ROOT,
    );
    expect("skip" in result).toBe(true);
  });

  test("skips a sibling directory that shares the root as a string prefix", () => {
    const result = reindexTarget(
      { tool_name: "Edit", tool_input: { file_path: "/work/repo-other/a.ts" } },
      ROOT,
    );
    expect("skip" in result).toBe(true);
  });

  test("skips an edit made inside a subagent", () => {
    const result = reindexTarget(
      {
        tool_name: "Edit",
        tool_input: { file_path: IN_ROOT },
        agent_id: "abc123",
      },
      ROOT,
    );
    expect(skipReason(result)).toContain("subagent");
  });

  test("skips a tool that does not write files, naming the tool", () => {
    const result = reindexTarget(
      { tool_name: "Read", tool_input: { file_path: IN_ROOT } },
      ROOT,
    );
    expect(skipReason(result)).toContain("Read");
  });

  test.each([
    "Edit",
    "Write",
    "MultiEdit",
  ])("accepts %s with an in-root path", (tool) => {
    const result = reindexTarget(
      { tool_name: tool, tool_input: { file_path: IN_ROOT } },
      ROOT,
    );
    expect(result).toEqual({ projectPath: ROOT, filePath: IN_ROOT });
  });

  test("skips when tool_input is missing", () => {
    const result = reindexTarget({ tool_name: "Edit" }, ROOT);
    expect(skipReason(result)).toContain("file_path");
  });

  test("skips when tool_input has no file_path", () => {
    const result = reindexTarget(
      { tool_name: "Edit", tool_input: { old_string: "a" } },
      ROOT,
    );
    expect(skipReason(result)).toContain("file_path");
  });

  test("skips an empty file_path", () => {
    const result = reindexTarget(
      { tool_name: "Write", tool_input: { file_path: "" } },
      ROOT,
    );
    expect(skipReason(result)).toContain("file_path");
  });
});
