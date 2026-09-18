import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, workerModelsFor, writeConfig } from "./shared-config";

let previousMimirHome: string | undefined;
let sandbox: string;

beforeAll(() => {
  previousMimirHome = process.env.MIMIR_HOME;
  sandbox = mkdtempSync(join(tmpdir(), "mimir-shared-config-test-"));
  process.env.MIMIR_HOME = sandbox;
});

afterAll(() => {
  if (previousMimirHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = previousMimirHome;
  rmSync(sandbox, { recursive: true, force: true });
});

describe("shared config round-trip", () => {
  test("missing file reads as null", async () => {
    expect(await readConfig()).toBeNull();
  });

  test("every optional field survives a write/read cycle", async () => {
    await writeConfig({
      serverUrl: "https://mimir.example.com",
      userMemoryDb: "/tmp/user.db",
      cartographerBinary: "/usr/local/bin/cartographer",
      apiKey: "gate-key",
      providerApiKey: "byok-key",
      provider: "openai",
      smallModel: "gpt-5-mini",
      extractionBaseUrl: "http://ollama.local/",
      extractionModel: "ornith:35b",
      extractionApiKey: "extract-key",
    });

    const read = await readConfig();
    expect(read).toEqual({
      serverUrl: "https://mimir.example.com",
      userMemoryDb: "/tmp/user.db",
      cartographerBinary: "/usr/local/bin/cartographer",
      apiKey: "gate-key",
      providerApiKey: "byok-key",
      provider: "openai",
      smallModel: "gpt-5-mini",
      extractionBaseUrl: "http://ollama.local/",
      extractionModel: "ornith:35b",
      extractionApiKey: "extract-key",
    });
  });

  test("normalizes a home-relative memory database path", async () => {
    await writeConfig({
      serverUrl: "https://mimir.example.com",
      userMemoryDb: "~/.mimir/user-memories.db",
    });

    const expected = join(
      process.env.HOME ?? homedir(),
      ".mimir",
      "user-memories.db",
    );
    expect((await readConfig())?.userMemoryDb).toBe(expected);
    const persisted = await Bun.file(join(sandbox, "config.json")).json();
    expect(persisted.userMemoryDb).toBe(expected);
  });

  test("installer merge pattern preserves fields the installer doesn't carry", async () => {
    // A cc install recorded the extraction trio…
    await writeConfig({
      serverUrl: "https://old.example.com",
      userMemoryDb: "/tmp/user.db",
      extractionBaseUrl: "http://ollama.local/",
      extractionModel: "ornith:35b",
    });

    // …then another distribution's installer runs with only its own
    // InstallOptions fields, using the spread-existing merge pattern
    // (install.ts in cc-plugin and codex-plugin).
    const existing = await readConfig();
    await writeConfig({
      ...(existing ?? {}),
      serverUrl: "https://new.example.com",
      userMemoryDb: "/tmp/user.db",
      apiKey: "fresh-key",
    });

    const merged = await readConfig();
    expect(merged?.serverUrl).toBe("https://new.example.com");
    expect(merged?.apiKey).toBe("fresh-key");
    // The fields the second installer never knew about survive.
    expect(merged?.extractionBaseUrl).toBe("http://ollama.local/");
    expect(merged?.extractionModel).toBe("ornith:35b");
  });

  test("malformed config degrades to null", async () => {
    await Bun.write(join(sandbox, "config.json"), "not json {");
    expect(await readConfig()).toBeNull();
  });
});

describe("workerModels (MIM-41 per-role worker models)", () => {
  const base = {
    serverUrl: "https://mimir.example.com",
    userMemoryDb: "/tmp/user.db",
  };

  test("a full workerModels value survives a write/read cycle exactly", async () => {
    await writeConfig({
      ...base,
      workerModels: {
        claudeCode: { impl: "opus", test: "sonnet", review: "fable" },
        opencode: { review: "anthropic/claude-opus-4" },
      },
    });

    expect(await readConfig()).toEqual({
      ...base,
      workerModels: {
        claudeCode: { impl: "opus", test: "sonnet", review: "fable" },
        opencode: { review: "anthropic/claude-opus-4" },
      },
    });
  });

  test("read drops non-string and empty role entries, then empty namespaces", async () => {
    await Bun.write(
      join(sandbox, "config.json"),
      JSON.stringify({
        ...base,
        workerModels: {
          claudeCode: { impl: "", review: 42 },
          opencode: { test: "x" },
        },
      }),
    );

    expect((await readConfig())?.workerModels).toEqual({
      opencode: { test: "x" },
    });
  });

  test("workerModels is absent (not {}) when no namespace survives", async () => {
    await Bun.write(
      join(sandbox, "config.json"),
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
    const path = join(sandbox, "config.json");

    await Bun.write(path, JSON.stringify({ ...base, workerModels: [] }));
    expect(await readConfig()).not.toHaveProperty("workerModels");

    await Bun.write(path, JSON.stringify({ ...base, workerModels: "opus" }));
    expect(await readConfig()).not.toHaveProperty("workerModels");

    await Bun.write(
      path,
      JSON.stringify({
        ...base,
        workerModels: { claudeCode: "opus", opencode: { review: "x" } },
      }),
    );
    expect((await readConfig())?.workerModels).toEqual({
      opencode: { review: "x" },
    });
  });

  test("a config without workerModels reads back without the key", async () => {
    await writeConfig(base);
    expect(await readConfig()).not.toHaveProperty("workerModels");
  });

  describe("workerModelsFor", () => {
    const config = {
      ...base,
      workerModels: {
        claudeCode: { impl: "opus", review: "fable" },
        opencode: { test: "anthropic/claude-sonnet-4" },
      },
    };

    test("returns the requested host namespace", () => {
      expect(workerModelsFor(config, "claudeCode")).toEqual({
        impl: "opus",
        review: "fable",
      });
      expect(workerModelsFor(config, "opencode")).toEqual({
        test: "anthropic/claude-sonnet-4",
      });
    });

    test("returns {} for a null config", () => {
      expect(workerModelsFor(null, "claudeCode")).toEqual({});
    });

    test("returns {} when workerModels is unset", () => {
      expect(workerModelsFor(base, "opencode")).toEqual({});
    });

    test("returns {} when the host namespace is unset", () => {
      expect(
        workerModelsFor(
          { ...base, workerModels: { claudeCode: { impl: "opus" } } },
          "opencode",
        ),
      ).toEqual({});
    });
  });
});
