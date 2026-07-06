import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "./config";

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
