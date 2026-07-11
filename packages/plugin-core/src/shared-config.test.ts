import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig } from "./shared-config";

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
