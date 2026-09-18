/**
 * Per-role worker models: config.json overlaid by the layered mimir.toml
 * (`[workers.models.<host>]`, user → project).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "../shared-config";
import { resolveWorkerModels, workerModelsFromToml } from "./models";

let previousMimirHome: string | undefined;
let home: string;
let project: string;

beforeAll(async () => {
  previousMimirHome = process.env.MIMIR_HOME;
  home = mkdtempSync(join(tmpdir(), "mimir-worker-models-home-"));
  project = mkdtempSync(join(tmpdir(), "mimir-worker-models-project-"));
  process.env.MIMIR_HOME = home;
  await writeConfig({
    serverUrl: "https://mimir.example.com",
    userMemoryDb: join(home, "user.db"),
    workerModels: {
      claudeCode: { impl: "opus", test: "opus", review: "opus" },
      opencode: { impl: "anthropic/claude-opus-4" },
    },
  });
});

afterAll(() => {
  if (previousMimirHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = previousMimirHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

const writeToml = (dir: string, text: string) => {
  mkdirSync(dir, { recursive: true });
  return Bun.write(join(dir, "mimir.toml"), text);
};

describe("workerModelsFromToml", () => {
  test("reads the host table, keeping only known roles with non-empty strings", () => {
    expect(
      workerModelsFromToml(
        {
          workers: {
            models: {
              opencode: {
                impl: "ollama/qwen3",
                test: "",
                review: 42,
                deploy: "x",
              },
              claudeCode: { review: "sonnet" },
            },
          },
        },
        "opencode",
      ),
    ).toEqual({ impl: "ollama/qwen3" });
  });

  test("missing or malformed tables read as no overrides", () => {
    expect(workerModelsFromToml({}, "claudeCode")).toEqual({});
    expect(workerModelsFromToml({ workers: "nope" }, "claudeCode")).toEqual({});
    expect(
      workerModelsFromToml(
        { workers: { models: { claudeCode: [] } } },
        "claudeCode",
      ),
    ).toEqual({});
  });
});

describe("resolveWorkerModels", () => {
  test("no mimir.toml anywhere → config.json values", async () => {
    expect(await resolveWorkerModels("claudeCode", project)).toEqual({
      impl: "opus",
      test: "opus",
      review: "opus",
    });
  });

  test("user mimir.toml overrides config.json per role; project overrides user", async () => {
    await writeToml(
      home,
      '[workers.models.claudeCode]\nreview = "sonnet"\n\n[workers.models.opencode]\nimpl = "ollama/qwen3"\nreview = "ollama/gemma4"\n',
    );
    await writeToml(
      project,
      '[workers.models.opencode]\nreview = "lmstudio/devstral"\n',
    );

    expect(await resolveWorkerModels("claudeCode", project)).toEqual({
      impl: "opus",
      test: "opus",
      review: "sonnet",
    });
    expect(await resolveWorkerModels("opencode", project)).toEqual({
      impl: "ollama/qwen3",
      review: "lmstudio/devstral",
    });
  });

  test("without a project root only the user layer applies", async () => {
    expect(await resolveWorkerModels("opencode")).toEqual({
      impl: "ollama/qwen3",
      review: "ollama/gemma4",
    });
  });
});
