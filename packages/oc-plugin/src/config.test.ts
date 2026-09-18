import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkerModels } from "@mimir/plugin-core/shared-config";
import { readConfig, writeConfig } from "./config";

// config.ts resolves its path via mimirHome(), which honours MIMIR_HOME.
// Point it at a throwaway dir per test so we exercise the real file read.

let home: string;
const prevHome = process.env.MIMIR_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mimir-oc-cfg-"));
  process.env.MIMIR_HOME = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

const writeConfigFile = (contents: string) =>
  writeFile(join(home, "config.json"), contents);

describe("readConfig", () => {
  test("returns null when the file is missing", async () => {
    expect(await readConfig()).toBeNull();
  });

  test("returns null on malformed JSON", async () => {
    await writeConfigFile("{ not json");
    expect(await readConfig()).toBeNull();
  });

  test("returns null when required fields are absent", async () => {
    await writeConfigFile(JSON.stringify({ serverUrl: "http://x" }));
    expect(await readConfig()).toBeNull();
  });

  test("reads the required fields", async () => {
    await writeConfigFile(
      JSON.stringify({
        serverUrl: "http://localhost:8080",
        userMemoryDb: "/db.sqlite",
      }),
    );
    expect(await readConfig()).toEqual({
      serverUrl: "http://localhost:8080",
      userMemoryDb: "/db.sqlite",
    });
  });

  test("normalizes a home-relative memory database path", async () => {
    await writeConfig({
      serverUrl: "http://localhost:8080",
      userMemoryDb: "~/.mimir/user-memories.db",
    });

    const expected = join(
      process.env.HOME ?? homedir(),
      ".mimir",
      "user-memories.db",
    );
    expect((await readConfig())?.userMemoryDb).toBe(expected);
    const persisted = await Bun.file(join(home, "config.json")).json();
    expect(persisted.userMemoryDb).toBe(expected);
  });

  test("includes optional fields only when present and non-empty", async () => {
    await writeConfigFile(
      JSON.stringify({
        serverUrl: "http://s",
        userMemoryDb: "/db",
        cartographerBinary: "/bin/carto",
        apiKey: "",
        provider: "anthropic",
        smallModel: "",
      }),
    );
    // Empty apiKey/smallModel are dropped; provider/cartographerBinary kept.
    expect(await readConfig()).toEqual({
      serverUrl: "http://s",
      userMemoryDb: "/db",
      cartographerBinary: "/bin/carto",
      provider: "anthropic",
    });
  });
});

describe("workerModels (MIM-41 per-role worker models)", () => {
  const base = {
    serverUrl: "http://localhost:8080",
    userMemoryDb: "/db.sqlite",
  };

  test("a full workerModels value survives a write/read cycle exactly", async () => {
    // Typed as the shared WorkerModels so oc-plugin's MimirConfig is
    // held to plugin-core's shape rather than a local redeclaration.
    const workerModels: WorkerModels = {
      claudeCode: { impl: "opus", test: "sonnet", review: "fable" },
      opencode: {
        impl: "anthropic/claude-sonnet-4",
        test: "openai/gpt-5-mini",
        review: "anthropic/claude-opus-4",
      },
    };
    await writeConfig({ ...base, workerModels });

    expect(await readConfig()).toEqual({ ...base, workerModels });
  });

  test("read drops non-string and empty role entries, then empty namespaces", async () => {
    await writeConfigFile(
      JSON.stringify({
        ...base,
        workerModels: {
          claudeCode: { impl: "", review: 42 },
          opencode: { test: "anthropic/claude-sonnet-4" },
        },
      }),
    );

    expect((await readConfig())?.workerModels).toEqual({
      opencode: { test: "anthropic/claude-sonnet-4" },
    });
  });

  test("workerModels is absent (not {}) when no namespace survives", async () => {
    await writeConfigFile(
      JSON.stringify({
        ...base,
        workerModels: { claudeCode: { impl: 7 }, opencode: {} },
      }),
    );

    const read = await readConfig();
    expect(read).not.toBeNull();
    expect(read).not.toHaveProperty("workerModels");
  });

  test("non-record shapes are dropped, not passed through", async () => {
    await writeConfigFile(JSON.stringify({ ...base, workerModels: [] }));
    expect(await readConfig()).not.toHaveProperty("workerModels");

    await writeConfigFile(JSON.stringify({ ...base, workerModels: "opus" }));
    expect(await readConfig()).not.toHaveProperty("workerModels");

    await writeConfigFile(
      JSON.stringify({
        ...base,
        workerModels: {
          claudeCode: "opus",
          opencode: { review: "anthropic/claude-opus-4" },
        },
      }),
    );
    expect((await readConfig())?.workerModels).toEqual({
      opencode: { review: "anthropic/claude-opus-4" },
    });
  });

  test("a config without workerModels reads back without the key", async () => {
    await writeConfig(base);
    expect(await readConfig()).not.toHaveProperty("workerModels");
  });
});
