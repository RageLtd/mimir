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
let savedMimirHome: string | undefined;

// Every env var these parsers read gets saved/cleared per test so the
// developer's real environment can't leak into toEqual assertions.
const PARSED_ENV_VARS = [
  "MIMIR_API_KEY",
  "MIMIR_PROVIDER_API_KEY",
  "MIMIR_PROVIDER",
  "MIMIR_SMALL_MODEL",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  for (const name of PARSED_ENV_VARS) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  savedMimirHome = process.env.MIMIR_HOME;
  mimirHomeDir = await mkdtemp(join(tmpdir(), "mimir-cli-args-"));
  process.env.MIMIR_HOME = mimirHomeDir;
});

afterEach(async () => {
  for (const name of PARSED_ENV_VARS) {
    const saved = savedEnv[name];
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
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

describe("BYOK provider flags (MIM-74)", () => {
  test("parses --provider-api-key / --provider / --small-model", () => {
    const parsed = parseInstallArgs([
      SERVER_URL,
      "--provider-api-key",
      "sk-prov",
      "--provider",
      "anthropic",
      "--small-model",
      "anthropic/haiku",
    ]);
    expect(parsed).toEqual({
      serverUrl: SERVER_URL,
      providerApiKey: "sk-prov",
      provider: "anthropic",
      smallModel: "anthropic/haiku",
    });
  });

  test("MIMIR_PROVIDER_API_KEY env fills in when the flag is absent", () => {
    process.env.MIMIR_PROVIDER_API_KEY = "sk-prov-env";
    const parsed = parseInstallArgs([SERVER_URL]);
    expect(parsed).toEqual({
      serverUrl: SERVER_URL,
      providerApiKey: "sk-prov-env",
    });
  });

  test("flags missing values error", () => {
    expect(parseInstallArgs([SERVER_URL, "--provider-api-key"])).toEqual({
      error: "--provider-api-key requires a value",
    });
    expect(parseInstallArgs([SERVER_URL, "--provider"])).toEqual({
      error: "--provider requires a value",
    });
    expect(parseInstallArgs([SERVER_URL, "--small-model"])).toEqual({
      error: "--small-model requires a value",
    });
  });

  test("mergeUpdateOptions preserves BYOK fields from config.json", async () => {
    await writeConfig({
      serverUrl: SERVER_URL,
      userMemoryDb: join(mimirHomeDir, "user-memories.db"),
      providerApiKey: "sk-prov-config",
      provider: "anthropic",
      smallModel: "anthropic/haiku",
    });
    const merged = await mergeUpdateOptions({});
    expect(merged).toEqual({
      serverUrl: SERVER_URL,
      userMemoryDb: join(mimirHomeDir, "user-memories.db"),
      providerApiKey: "sk-prov-config",
      provider: "anthropic",
      smallModel: "anthropic/haiku",
    });
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

describe("extraction flags (dead-brain fix)", () => {
  test("parses --extraction-base-url / --extraction-model", () => {
    const parsed = parseInstallArgs([
      SERVER_URL,
      "--extraction-base-url",
      "http://ollama.local/",
      "--extraction-model",
      "ornith:35b",
    ]);
    expect(parsed).toEqual({
      serverUrl: SERVER_URL,
      extractionBaseUrl: "http://ollama.local/",
      extractionModel: "ornith:35b",
    });
  });

  test("flags missing values error", () => {
    expect(parseInstallArgs([SERVER_URL, "--extraction-base-url"])).toEqual({
      error: "--extraction-base-url requires a value",
    });
    expect(parseInstallArgs([SERVER_URL, "--extraction-model"])).toEqual({
      error: "--extraction-model requires a value",
    });
  });

  test("mergeUpdateOptions preserves extraction fields from config.json", async () => {
    await writeConfig({
      serverUrl: SERVER_URL,
      userMemoryDb: join(mimirHomeDir, "user-memories.db"),
      extractionBaseUrl: "http://ollama.local/",
      extractionModel: "ornith:35b",
    });
    const merged = await mergeUpdateOptions({});
    expect(merged).toEqual({
      serverUrl: SERVER_URL,
      userMemoryDb: join(mimirHomeDir, "user-memories.db"),
      extractionBaseUrl: "http://ollama.local/",
      extractionModel: "ornith:35b",
    });
  });
});
