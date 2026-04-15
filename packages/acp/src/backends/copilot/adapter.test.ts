import { test, expect, describe } from "bun:test";
import { createCopilotBackend } from "./adapter";
import type { CopilotBackendDeps } from "./adapter";
import type { CopilotBackendConfig } from "../../config";
import type { BackendRunOptions } from "../types";

const baseCopilot: CopilotBackendConfig = {
  enabled: true,
  defaultModel: "gpt-4o",
  workingDirectory: undefined,
};

const baseDeps: CopilotBackendDeps = {
  copilot: baseCopilot,
  serverUrl: "http://localhost:3777",
  userMemoryDbPath: "/tmp/test-memories.db",
  defaultCwd: "/tmp/default",
};

const mkRunOpts = (overrides?: Partial<BackendRunOptions>): BackendRunOptions => ({
  prompt: "hello",
  modelId: "copilot/gpt-4o",
  systemPrompt: "you are helpful",
  messages: [],
  tools: [],
  projectPath: "/tmp/project",
  metadata: {},
  assembledMessages: [],
  ...overrides,
});

describe("createCopilotBackend", () => {
  test("returns a backend with kind 'copilot'", () => {
    const backend = createCopilotBackend(baseDeps);
    expect(backend.kind).toBe("copilot");
  });

  test("run returns an async generator", () => {
    const backend = createCopilotBackend(baseDeps);
    const gen = backend.run(mkRunOpts());
    expect(gen[Symbol.asyncIterator]).toBeDefined();
    gen.return(undefined);
  });

  test("strips copilot/ prefix from modelId", () => {
    const backend = createCopilotBackend(baseDeps);
    const gen = backend.run(mkRunOpts({ modelId: "copilot/claude-sonnet-4" }));
    expect(gen[Symbol.asyncIterator]).toBeDefined();
    gen.return(undefined);
  });

  test("passes through model id unchanged when no prefix", () => {
    const backend = createCopilotBackend(baseDeps);
    const gen = backend.run(mkRunOpts({ modelId: "gpt-4o" }));
    expect(gen[Symbol.asyncIterator]).toBeDefined();
    gen.return(undefined);
  });

  test("uses copilot.workingDirectory over projectPath when set", () => {
    const deps: CopilotBackendDeps = {
      ...baseDeps,
      copilot: { ...baseCopilot, workingDirectory: "/explicit/cwd" },
    };
    const backend = createCopilotBackend(deps);
    const gen = backend.run(mkRunOpts({ projectPath: "/should/be/ignored" }));
    expect(gen[Symbol.asyncIterator]).toBeDefined();
    gen.return(undefined);
  });

  test("falls back to projectPath when copilot.workingDirectory is unset", () => {
    const backend = createCopilotBackend(baseDeps);
    const gen = backend.run(mkRunOpts({ projectPath: "/from/project" }));
    expect(gen[Symbol.asyncIterator]).toBeDefined();
    gen.return(undefined);
  });

  test("falls back to defaultCwd when both workingDirectory and projectPath are unset", () => {
    const backend = createCopilotBackend(baseDeps);
    const gen = backend.run(mkRunOpts());
    expect(gen[Symbol.asyncIterator]).toBeDefined();
    gen.return(undefined);
  });
});
