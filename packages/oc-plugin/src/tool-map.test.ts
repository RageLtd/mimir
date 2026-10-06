import { describe, expect, test } from "bun:test";
import { type RuleEntry, runRules } from "@mimir/plugin-core/rules";
import { normalizeToolCalls } from "./tool-map";
import { createSessionRoles, guardReason } from "./worker-hooks";

const patch = (...lines: string[]) => ({
  patchText: ["*** Begin Patch", ...lines, "*** End Patch"].join("\n"),
});

const findings = async (input: unknown, rules: RuleEntry[]) =>
  (
    await Promise.all(
      normalizeToolCalls("patch", input).map((call) =>
        runRules(rules, { ...call, projectPath: "/repo" }),
      ),
    )
  ).flat();

const noClasses: RuleEntry = {
  id: "no-classes",
  enabled: true,
  event: "file",
  paths: ["**/*.ts"],
  sourcePath: "/repo/no-classes.enforce.toml",
  conditions: [{ field: "new_text", operator: "contains", pattern: "class " }],
};

describe("normalizeToolCalls", () => {
  test("nested locations resolve native file paths independently of project root", () => {
    const directory = "/repo/packages/api";
    for (const tool of ["read", "write", "edit"]) {
      expect(
        normalizeToolCalls(tool, { path: "src/a.ts" }, directory)[0]?.toolInput
          .file_path,
      ).toBe("/repo/packages/api/src/a.ts");
      expect(
        normalizeToolCalls(tool, { path: "/repo/shared.ts" }, directory)[0]
          ?.toolInput.file_path,
      ).toBe("/repo/shared.ts");
    }
    expect(
      normalizeToolCalls("read", {}, directory)[0]?.toolInput.file_path,
    ).toBeUndefined();
  });

  test("shell cwd defaults to location and resolves explicit native workdir", () => {
    const directory = "/repo/packages/api";
    expect(
      normalizeToolCalls("shell", { command: "bun test" }, directory)[0]
        ?.toolInput.cwd,
    ).toBe(directory);
    expect(
      normalizeToolCalls(
        "shell",
        { command: "bun test", workdir: "../web" },
        directory,
      )[0]?.toolInput.cwd,
    ).toBe("/repo/packages/web");
    expect(
      normalizeToolCalls(
        "Bash",
        { command: "bun test", cwd: "/repo" },
        directory,
      )[0]?.toolInput.cwd,
    ).toBe("/repo");
  });

  test("nested patch moves resolve both scope paths and projection source", () => {
    const calls = normalizeToolCalls(
      "patch",
      patch(
        "*** Update File: src/a.test.ts",
        "*** Move to: src/a.ts",
        "@@",
        "-old",
        "+new",
        "*** Add File: ../shared.ts",
        "+export {};",
        "*** Delete File: obsolete.ts",
      ),
      "/repo/packages/api",
    );
    expect(calls.map((call) => call.toolInput.file_path)).toEqual([
      "/repo/packages/api/src/a.test.ts",
      "/repo/packages/api/src/a.ts",
      "/repo/packages/shared.ts",
      "/repo/packages/api/obsolete.ts",
    ]);
    expect(calls[1]?.toolInput.projection_source_path).toBe(
      "/repo/packages/api/src/a.test.ts",
    );
    expect(calls[1]?.toolInput.edits).toEqual([
      { old_string: "old", new_string: "new" },
    ]);
    expect(calls[0]?.toolInput.projection_source_path).toBeUndefined();
    expect(calls[0]?.toolInput.deleted).toBe(true);
    expect(calls[1]?.toolInput.deleted).toBeUndefined();
    expect(calls[3]?.toolInput.deleted).toBe(true);
  });

  test("maps native shell, edit and write fields", () => {
    expect(
      normalizeToolCalls("shell", { command: "bun test", workdir: "/repo" }),
    ).toEqual([
      { toolName: "Bash", toolInput: { command: "bun test", cwd: "/repo" } },
    ]);
    expect(
      normalizeToolCalls("edit", {
        path: "a.ts",
        oldString: "old",
        newString: "new",
        replaceAll: false,
      }),
    ).toEqual([
      {
        toolName: "Edit",
        toolInput: {
          file_path: "a.ts",
          old_string: "old",
          new_string: "new",
          replace_all: false,
        },
      },
    ]);
    expect(
      normalizeToolCalls("write", { path: "a.ts", content: "text\n" }),
    ).toEqual([
      {
        toolName: "Write",
        toolInput: { file_path: "a.ts", content: "text\n" },
      },
    ]);
  });

  test("maps reads without making them file mutation events", async () => {
    const calls = normalizeToolCalls("read", { path: "a.ts", offset: 3 });
    expect(calls).toEqual([
      { toolName: "Read", toolInput: { file_path: "a.ts" } },
    ]);
    const read = calls[0];
    if (!read) throw new Error("Expected a normalized Read call");
    expect(
      await runRules([{ ...noClasses, conditions: [] }], {
        ...read,
        projectPath: "/repo",
      }),
    ).toEqual([]);
  });

  test("passes unknown tools through and sanitizes non-object inputs", () => {
    const input = { query: "needle" };
    expect(normalizeToolCalls("grep", input)).toEqual([
      { toolName: "grep", toolInput: input },
    ]);
    for (const invalid of [null, undefined, "text", 42, []]) {
      expect(normalizeToolCalls("custom", invalid)).toEqual([
        { toolName: "custom", toolInput: {} },
      ]);
      expect(normalizeToolCalls("patch", invalid)).toEqual([]);
    }
    expect(normalizeToolCalls("patch", { patchText: 42 })).toEqual([]);
    expect(normalizeToolCalls("patch", patch())).toEqual([]);
  });

  test("adds all plus-prefixed lines with blank lines and final newline", () => {
    expect(
      normalizeToolCalls(
        "patch",
        patch("*** Add File: a.ts", "+const a = 1;", "+", "+// end"),
      ),
    ).toEqual([
      {
        toolName: "Write",
        toolInput: { file_path: "a.ts", content: "const a = 1;\n\n// end\n" },
      },
    ]);
    expect(
      normalizeToolCalls("patch", patch("*** Add File: empty.ts")),
    ).toEqual([
      { toolName: "Write", toolInput: { file_path: "empty.ts", content: "" } },
    ]);
  });

  test("updates preserve context and separate @@ hunks", () => {
    expect(
      normalizeToolCalls(
        "patch",
        patch(
          "*** Update File: a.ts",
          "@@ function first()",
          " before",
          "-old",
          "+new",
          " ",
          " after",
          "@@",
          "-last",
          "+final",
          "*** End of File",
        ),
      ),
    ).toEqual([
      {
        toolName: "MultiEdit",
        toolInput: {
          file_path: "a.ts",
          edits: [
            {
              old_string: "before\nold\n\nafter",
              new_string: "before\nnew\n\nafter",
            },
            { old_string: "last", new_string: "final" },
          ],
        },
      },
    ]);
  });

  test("class detection sees additions, not removed text or @@ anchors", async () => {
    const removed = patch(
      "*** Update File: a.ts",
      "@@ class Anchor",
      "-class Removed {}",
      "+const replacement = {};",
    );
    expect(await findings(removed, [noClasses])).toEqual([]);
    for (const header of ["*** Add File: a.ts", "*** Update File: a.ts"]) {
      expect(
        await findings(patch(header, "+class Added {}"), [noClasses]),
      ).toHaveLength(1);
    }
  });

  test("mixed Python/TypeScript patches keep scope and content per file", async () => {
    const input = patch(
      "*** Add File: src/model.py",
      "+class Python: pass",
      "*** Update File: src/model.ts",
      "@@",
      "-class Old {}",
      "+const model = {};",
      "*** Add File: src/bad.ts",
      "+class Bad {}",
    );
    const calls = normalizeToolCalls("patch", input);
    expect(calls.map((call) => call.toolInput.file_path)).toEqual([
      "src/model.py",
      "src/model.ts",
      "src/bad.ts",
    ]);
    expect(await findings(input, [noClasses])).toHaveLength(1);
  });

  test("moves enforce both source and destination scopes across extensions", async () => {
    const input = patch(
      "*** Update File: src/old.py",
      "*** Move to: src/new.ts",
      "@@",
      "-old",
      "+class Moved {}",
    );
    expect(normalizeToolCalls("patch", input)).toEqual([
      {
        toolName: "Edit",
        toolInput: {
          file_path: "src/old.py",
          old_string: "",
          new_string: "",
          deleted: true,
        },
      },
      {
        toolName: "MultiEdit",
        toolInput: {
          file_path: "src/new.ts",
          projection_source_path: "src/old.py",
          edits: [{ old_string: "old", new_string: "class Moved {}" }],
        },
      },
    ]);
    const sourceRule: RuleEntry = {
      ...noClasses,
      id: "protect-python-source",
      paths: ["**/*.py"],
      conditions: [
        { field: "file_path", operator: "equals", pattern: "src/old.py" },
      ],
    };
    expect(
      (await findings(input, [sourceRule, noClasses])).map(
        (finding) => finding.rule.id,
      ),
    ).toEqual(["protect-python-source", "no-classes"]);
  });

  test("impl cannot move a protected test to an implementation path", async () => {
    const roles = createSessionRoles(async () => ({
      parentID: "main",
      agent: "mimir-impl",
    }));
    const calls = normalizeToolCalls(
      "patch",
      patch(
        "*** Update File: src/a.test.ts",
        "*** Move to: src/a.ts",
        "@@",
        "-old",
        "+new",
      ),
    );
    const reasons = await Promise.all(
      calls.map((call) =>
        guardReason(
          roles,
          { tool: call.toolName, sessionID: "worker" },
          call.toolInput,
          "/repo",
        ),
      ),
    );
    expect(reasons[0]).toContain("mimir-impl");
    expect(reasons[1]).toBeNull();
  });

  test("hunkless moves retain both paths and the source projection contract", () => {
    expect(
      normalizeToolCalls(
        "patch",
        patch("*** Update File: src/old.ts", "*** Move to: src/new.ts"),
      ),
    ).toEqual([
      {
        toolName: "Edit",
        toolInput: {
          file_path: "src/old.ts",
          old_string: "",
          new_string: "",
          deleted: true,
        },
      },
      {
        toolName: "MultiEdit",
        toolInput: {
          file_path: "src/new.ts",
          projection_source_path: "src/old.ts",
          edits: [],
        },
      },
    ]);
  });

  test("deletion has empty Edit content for path-only enforcement", async () => {
    const input = patch("*** Delete File: protected.ts");
    expect(normalizeToolCalls("patch", input)).toEqual([
      {
        toolName: "Edit",
        toolInput: {
          file_path: "protected.ts",
          old_string: "",
          new_string: "",
          deleted: true,
        },
      },
    ]);
    expect(await findings(input, [noClasses])).toEqual([]);
    expect(
      await findings(input, [
        {
          ...noClasses,
          conditions: [
            { field: "file_path", operator: "equals", pattern: "protected.ts" },
          ],
        },
      ]),
    ).toHaveLength(1);
  });

  test("CRLF documents and header-like content remain bounded by real headers", () => {
    const input = patch(
      "*** Add File: spaced name.ts",
      "+*** Delete File: not-a-header.ts",
      "*** Update File: other.ts",
      "@@",
      "-*** Add File: old-text.ts",
      "+*** Add File: new-text.ts",
    );
    const calls = normalizeToolCalls("patch", {
      patchText: `${input.patchText.replaceAll("\n", "\r\n")}\r\n`,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.toolInput).toEqual({
      file_path: "spaced name.ts",
      content: "*** Delete File: not-a-header.ts\n",
    });
    expect(calls[1]?.toolInput.edits).toEqual([
      {
        old_string: "*** Add File: old-text.ts",
        new_string: "*** Add File: new-text.ts",
      },
    ]);
  });
});
