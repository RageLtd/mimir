import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runRules } from "./runner";
import type { RuleEntry } from "./types";

let projectPath: string;
beforeEach(async () => {
  projectPath = await mkdtemp(join(tmpdir(), "rules-move-projection-"));
  await writeFile(join(projectPath, "source.py"), "one\ntwo\nthree\nfour");
});
afterEach(async () => {
  await rm(projectPath, { recursive: true, force: true });
});

const rule: RuleEntry = {
  id: "file-length",
  event: "file",
  enabled: true,
  sourcePath: "rule.enforce.toml",
  paths: ["*.ts"],
  detector: "builtin:file-length",
  detectorArgs: { limit: 3 },
};

test("file-length scopes a move to destination and projects content from source", async () => {
  expect(
    await runRules([rule], {
      projectPath,
      toolName: "MultiEdit",
      toolInput: {
        file_path: "destination.ts",
        projection_source_path: "source.py",
        edits: [],
      },
    }),
  ).toHaveLength(1);
  expect(
    await runRules([rule], {
      projectPath,
      toolName: "MultiEdit",
      toolInput: {
        file_path: "destination.ts",
        projection_source_path: "source.py",
        edits: [{ old_string: "three\nfour", new_string: "three" }],
      },
    }),
  ).toEqual([]);
});

test("deletions do not get blocked by the source file's existing length", async () => {
  expect(
    await runRules([{ ...rule, paths: undefined }], {
      projectPath,
      toolName: "Edit",
      toolInput: {
        file_path: "source.py",
        old_string: "",
        new_string: "",
        deleted: true,
      },
    }),
  ).toEqual([]);
});
