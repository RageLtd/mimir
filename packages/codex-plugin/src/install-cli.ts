/**
 * Argument parsing + dispatch for the install/update subcommands,
 * extracted from cli.ts so tests can import it — cli.ts calls
 * process.exit at module top level, which would kill the test runner.
 *
 * Same flag surface as cc-plugin's installer; `update` layers CLI args
 * over the existing shared ~/.mimir/config.json so a bare update is a
 * true refresh (re-fetch persona, re-render config.toml, re-trust
 * hooks).
 */

import { readConfig } from "@mimir/plugin-core/shared-config";
import type { InstallOptions } from "./install";
import { runInstallCommand } from "./install";

export type PartialOptions = {
  readonly serverUrl?: string;
  readonly userMemoryDb?: string;
  readonly cartographerBinary?: string;
  readonly apiKey?: string;
  readonly providerApiKey?: string;
  readonly provider?: string;
  readonly smallModel?: string;
  readonly extractionBaseUrl?: string;
  readonly extractionModel?: string;
};

/**
 * Parse the shared argv shape — optional positional URL plus optional
 * flags. Used by both `install` (which then requires serverUrl) and
 * `update` (which layers the partial over existing config.json).
 */
export const parsePartialOptions = (rest: readonly string[]) => {
  let serverUrl: string | undefined;
  let userMemoryDb: string | undefined;
  let cartographerBinary: string | undefined;
  let apiKey: string | undefined;
  let providerApiKey: string | undefined;
  let provider: string | undefined;
  let smallModel: string | undefined;
  let extractionBaseUrl: string | undefined;
  let extractionModel: string | undefined;

  let i = 0;
  while (i < rest.length) {
    const arg = rest[i];
    if (arg === "--api-key") {
      apiKey = rest[i + 1];
      if (!apiKey) return { error: "--api-key requires a value" };
      i += 2;
      continue;
    }
    if (arg === "--provider-api-key") {
      providerApiKey = rest[i + 1];
      if (!providerApiKey) {
        return { error: "--provider-api-key requires a value" };
      }
      i += 2;
      continue;
    }
    if (arg === "--provider") {
      provider = rest[i + 1];
      if (!provider) return { error: "--provider requires a value" };
      i += 2;
      continue;
    }
    if (arg === "--small-model") {
      smallModel = rest[i + 1];
      if (!smallModel) return { error: "--small-model requires a value" };
      i += 2;
      continue;
    }
    if (arg === "--extraction-base-url") {
      extractionBaseUrl = rest[i + 1];
      if (!extractionBaseUrl) {
        return { error: "--extraction-base-url requires a value" };
      }
      i += 2;
      continue;
    }
    if (arg === "--extraction-model") {
      extractionModel = rest[i + 1];
      if (!extractionModel) {
        return { error: "--extraction-model requires a value" };
      }
      i += 2;
      continue;
    }
    if (arg === "--user-memory-db") {
      userMemoryDb = rest[i + 1];
      if (!userMemoryDb) return { error: "--user-memory-db requires a path" };
      i += 2;
      continue;
    }
    if (arg === "--cartographer") {
      cartographerBinary = rest[i + 1];
      if (!cartographerBinary) {
        return { error: "--cartographer requires a path" };
      }
      i += 2;
      continue;
    }
    if (arg?.startsWith("--")) {
      return { error: `unknown flag: ${arg}` } as const;
    }
    if (!serverUrl) {
      serverUrl = arg;
      i += 1;
      continue;
    }
    return { error: `unexpected argument: ${arg}` } as const;
  }

  // Constructed explicitly typed so the inferred return stays
  // `PartialOptions | { error: string }` for `"error" in` narrowing.
  const result: PartialOptions = {
    ...(serverUrl ? { serverUrl } : {}),
    ...(userMemoryDb ? { userMemoryDb } : {}),
    ...(cartographerBinary ? { cartographerBinary } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(providerApiKey ? { providerApiKey } : {}),
    ...(provider ? { provider } : {}),
    ...(smallModel ? { smallModel } : {}),
    ...(extractionBaseUrl ? { extractionBaseUrl } : {}),
    ...(extractionModel ? { extractionModel } : {}),
  };
  return result;
};

/**
 * No-paste discipline: keys reach the binary through the environment
 * without entering the chat transcript or process argv.
 */
const envApiKey = () => process.env.MIMIR_API_KEY || undefined;
const envProviderApiKey = () => process.env.MIMIR_PROVIDER_API_KEY || undefined;

export const parseInstallArgs = (rest: readonly string[]) => {
  const partial = parsePartialOptions(rest);
  if ("error" in partial) return partial;
  if (!partial.serverUrl) {
    return { error: "server URL is required" } as const;
  }
  const apiKey = partial.apiKey ?? envApiKey();
  const providerApiKey = partial.providerApiKey ?? envProviderApiKey();
  const result: InstallOptions = {
    serverUrl: partial.serverUrl,
    ...(partial.userMemoryDb ? { userMemoryDb: partial.userMemoryDb } : {}),
    ...(partial.cartographerBinary
      ? { cartographerBinary: partial.cartographerBinary }
      : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(providerApiKey ? { providerApiKey } : {}),
    ...(partial.provider ? { provider: partial.provider } : {}),
    ...(partial.smallModel ? { smallModel: partial.smallModel } : {}),
    ...(partial.extractionBaseUrl
      ? { extractionBaseUrl: partial.extractionBaseUrl }
      : {}),
    ...(partial.extractionModel
      ? { extractionModel: partial.extractionModel }
      : {}),
  };
  return result;
};

/**
 * Layer partial CLI args over the existing shared config.json so
 * `update` with no args is a true no-op refresh. URL precedence: CLI
 * flag > config.json. Key precedence: CLI flag > env > config.json.
 */
export const mergeUpdateOptions = async (partial: PartialOptions) => {
  const existing = await readConfig();

  const serverUrl = partial.serverUrl ?? existing?.serverUrl;
  if (!serverUrl) {
    return {
      error:
        "No URL provided and no existing config to recover from.\n" +
        "Run: mimir-codex-bin update <mimir-server-url>",
    } as const;
  }

  const userMemoryDb = partial.userMemoryDb ?? existing?.userMemoryDb;
  const cartographerBinary =
    partial.cartographerBinary ?? existing?.cartographerBinary;
  const apiKey = partial.apiKey ?? envApiKey() ?? existing?.apiKey;
  const providerApiKey =
    partial.providerApiKey ?? envProviderApiKey() ?? existing?.providerApiKey;
  const provider = partial.provider ?? existing?.provider;
  const smallModel = partial.smallModel ?? existing?.smallModel;
  const extractionBaseUrl =
    partial.extractionBaseUrl ?? existing?.extractionBaseUrl;
  const extractionModel = partial.extractionModel ?? existing?.extractionModel;

  const merged: InstallOptions = {
    serverUrl,
    ...(userMemoryDb ? { userMemoryDb } : {}),
    ...(cartographerBinary ? { cartographerBinary } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(providerApiKey ? { providerApiKey } : {}),
    ...(provider ? { provider } : {}),
    ...(smallModel ? { smallModel } : {}),
    ...(extractionBaseUrl ? { extractionBaseUrl } : {}),
    ...(extractionModel ? { extractionModel } : {}),
  };
  return merged;
};

/** Dispatch entry used by cli.ts for both install and update. */
export const runInstallCli = async (
  command: "install" | "update",
  rest: readonly string[],
) => {
  if (command === "install") {
    const parsed = parseInstallArgs(rest);
    if ("error" in parsed) {
      console.error(parsed.error);
      return 1;
    }
    return runInstallCommand(parsed);
  }

  const partial = parsePartialOptions(rest);
  if ("error" in partial) {
    console.error(partial.error);
    return 1;
  }
  const merged = await mergeUpdateOptions(partial);
  if ("error" in merged) {
    console.error(`Update failed: ${merged.error}`);
    return 1;
  }
  return runInstallCommand(merged);
};
