import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeConfig } from "@mimir/plugin-core/shared-config";
import { mergeUpdateOptions, parseInstallArgs } from "./install-cli";

const SERVER_URL = "https://mimir.example.com";

let mimirHomeDir: string;
let savedMimirHome: string | undefined;
let savedApiKey: string | undefined;
let savedProviderKey: string | undefined;

beforeEach(async () => {
  savedApiKey = process.env.MIMIR_API_KEY;
  savedProviderKey = process.env.MIMIR_PROVIDER_API_KEY;
  delete process.env.MIMIR_API_KEY;
  delete process.env.MIMIR_PROVIDER_API_KEY;
  savedMimirHome = process.env.MIMIR_HOME;
  mimirHomeDir = await mkdtemp(join(tmpdir(), "mimir-codex-cli-"));
  process.env.MIMIR_HOME = mimirHomeDir;
});

afterEach(async () => {
  if (savedApiKey === undefined) delete process.env.MIMIR_API_KEY;
  else process.env.MIMIR_API_KEY = savedApiKey;
  if (savedProviderKey === undefined) delete process.env.MIMIR_PROVIDER_API_KEY;
  else process.env.MIMIR_PROVIDER_API_KEY = savedProviderKey;
  if (savedMimirHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = savedMimirHome;
  await rm(mimirHomeDir, { recursive: true, force: true });
});

describe("parseInstallArgs", () => {
  test("requires a server URL", () => {
    expect(parseInstallArgs([])).toEqual({ error: "server URL is required" });
  });

  test("parses extraction flags", () => {
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

  test("unknown flags error", () => {
    expect(parseInstallArgs([SERVER_URL, "--bogus"])).toEqual({
      error: "unknown flag: --bogus",
    });
  });
});

describe("mergeUpdateOptions", () => {
  test("errors without a URL or existing config", async () => {
    const merged = await mergeUpdateOptions({});
    expect("error" in merged).toBe(true);
  });

  test("preserves stored fields, including extraction — but not the cartographer path", async () => {
    await writeConfig({
      serverUrl: SERVER_URL,
      userMemoryDb: join(mimirHomeDir, "user-memories.db"),
      cartographerBinary: "/usr/local/bin/cartographer",
      extractionBaseUrl: "http://ollama.local/",
      extractionModel: "ornith:35b",
    });
    const merged = await mergeUpdateOptions({});
    // Only an explicit --cartographer flag names a binary; the installer
    // otherwise downloads the latest release. Carrying the stored path
    // here would assert it like a flag and fail `update` on a moved binary.
    expect(merged).toEqual({
      serverUrl: SERVER_URL,
      userMemoryDb: join(mimirHomeDir, "user-memories.db"),
      extractionBaseUrl: "http://ollama.local/",
      extractionModel: "ornith:35b",
    });
  });
});
