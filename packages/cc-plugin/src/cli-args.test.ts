import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeUpdateOptions, parseInstallArgs } from "./cli-args";
import { writeConfig } from "./config";

const SERVER_URL = "https://mimir.example.com";
const FLAG_KEY = "key-from-flag";
const ENV_KEY = "key-from-env";
const CONFIG_KEY = "key-from-config";

let mimirHomeDir: string;
let savedApiKey: string | undefined;
let savedMimirHome: string | undefined;

beforeEach(async () => {
  savedApiKey = process.env.MIMIR_API_KEY;
  savedMimirHome = process.env.MIMIR_HOME;
  delete process.env.MIMIR_API_KEY;
  mimirHomeDir = await mkdtemp(join(tmpdir(), "mimir-cli-args-"));
  process.env.MIMIR_HOME = mimirHomeDir;
});

afterEach(async () => {
  if (savedApiKey === undefined) delete process.env.MIMIR_API_KEY;
  else process.env.MIMIR_API_KEY = savedApiKey;
  if (savedMimirHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = savedMimirHome;
  await rm(mimirHomeDir, { recursive: true, force: true });
});

describe("parseInstallArgs api key resolution", () => {
  test("--api-key flag wins over MIMIR_API_KEY env", () => {
    process.env.MIMIR_API_KEY = ENV_KEY;
    const parsed = parseInstallArgs([SERVER_URL, "--api-key", FLAG_KEY]);
    expect(parsed).toEqual({ serverUrl: SERVER_URL, apiKey: FLAG_KEY });
  });

  test("MIMIR_API_KEY env fills in when the flag is absent", () => {
    process.env.MIMIR_API_KEY = ENV_KEY;
    const parsed = parseInstallArgs([SERVER_URL]);
    expect(parsed).toEqual({ serverUrl: SERVER_URL, apiKey: ENV_KEY });
  });

  test("no flag and no env leaves apiKey unset", () => {
    const parsed = parseInstallArgs([SERVER_URL]);
    expect(parsed).toEqual({ serverUrl: SERVER_URL });
  });

  test("empty MIMIR_API_KEY is treated as unset", () => {
    process.env.MIMIR_API_KEY = "";
    const parsed = parseInstallArgs([SERVER_URL]);
    expect(parsed).toEqual({ serverUrl: SERVER_URL });
  });
});

describe("mergeUpdateOptions api key resolution", () => {
  const dbPath = () => join(mimirHomeDir, "user-memories.db");

  const writeExistingConfig = async () => {
    await writeConfig({
      serverUrl: SERVER_URL,
      userMemoryDb: dbPath(),
      apiKey: CONFIG_KEY,
    });
  };

  test("MIMIR_API_KEY env overrides the key stored in config.json", async () => {
    await writeExistingConfig();
    process.env.MIMIR_API_KEY = ENV_KEY;
    const merged = await mergeUpdateOptions({});
    expect(merged).toEqual({
      serverUrl: SERVER_URL,
      userMemoryDb: dbPath(),
      apiKey: ENV_KEY,
    });
  });

  test("config.json key is preserved when flag and env are absent", async () => {
    await writeExistingConfig();
    const merged = await mergeUpdateOptions({});
    expect(merged).toEqual({
      serverUrl: SERVER_URL,
      userMemoryDb: dbPath(),
      apiKey: CONFIG_KEY,
    });
  });

  test("--api-key flag wins over env and config.json", async () => {
    await writeExistingConfig();
    process.env.MIMIR_API_KEY = ENV_KEY;
    const merged = await mergeUpdateOptions({ apiKey: FLAG_KEY });
    expect(merged).toEqual({
      serverUrl: SERVER_URL,
      userMemoryDb: dbPath(),
      apiKey: FLAG_KEY,
    });
  });
});
