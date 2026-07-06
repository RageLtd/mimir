/**
 * Argument parsing for the install/update subcommands, extracted from
 * cli.ts so tests can import it — cli.ts dispatches and calls
 * process.exit at module top level, which would kill the test runner.
 */

import { join } from "node:path";
import { mimirHome } from "@mimir/plugin-core/util";
import { readConfig } from "./config";
import type { InstallOptions } from "./install";

type McpConfig = {
  readonly mcpServers?: Record<string, { readonly url?: string }>;
};

/**
 * Recover the mimir-server base URL from a previously installed mcp.json.
 *
 * The MCP config stores the full endpoint URL (`<base>/mcp`); we strip the
 * `/mcp` suffix so `update` calls fetchSystemPrompt with the same base URL
 * the original install used.
 */
const readUrlFromExistingMcpConfig = async (): Promise<string | undefined> => {
  const mcpPath = join(mimirHome(), "mcp.json");
  const file = Bun.file(mcpPath);
  if (!(await file.exists())) return undefined;

  let parsed: McpConfig;
  try {
    parsed = (await file.json()) as McpConfig;
  } catch {
    return undefined;
  }

  const url = parsed.mcpServers?.mimir?.url;
  if (typeof url !== "string") return undefined;

  return url.replace(/\/mcp\/?$/, "");
};

export type PartialOptions = {
  readonly serverUrl?: string;
  readonly userMemoryDb?: string;
  readonly cartographerBinary?: string;
  readonly apiKey?: string;
  readonly providerApiKey?: string;
  readonly provider?: string;
  readonly smallModel?: string;
};

/**
 * Parse the shared argv shape — optional positional URL plus optional
 * `--user-memory-db` / `--cartographer` flags. Used by both `install`
 * (which then requires serverUrl) and `update` (which layers the
 * partial over existing config.json).
 */
export const parsePartialOptions = (rest: readonly string[]) => {
  let serverUrl: string | undefined;
  let userMemoryDb: string | undefined;
  let cartographerBinary: string | undefined;
  let apiKey: string | undefined;
  let providerApiKey: string | undefined;
  let provider: string | undefined;
  let smallModel: string | undefined;

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

  // Construct the result explicitly typed so the inferred return type
  // of this function stays as `PartialOptions | { error: string }` —
  // without this, TS infers the spread shape too loosely and
  // downstream `"error" in result` narrowing breaks at call sites.
  const result: PartialOptions = {
    ...(serverUrl ? { serverUrl } : {}),
    ...(userMemoryDb ? { userMemoryDb } : {}),
    ...(cartographerBinary ? { cartographerBinary } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(providerApiKey ? { providerApiKey } : {}),
    ...(provider ? { provider } : {}),
    ...(smallModel ? { smallModel } : {}),
  };
  return result;
};

/**
 * The `--api-key` flag wins; the MIMIR_API_KEY env var is the no-paste
 * path the install skill steers users toward — the key reaches the
 * binary through the environment without ever entering the chat
 * transcript or the process argv.
 */
const envApiKey = () => {
  const key = process.env.MIMIR_API_KEY;
  return key ? key : undefined;
};

/** Same no-paste discipline as MIMIR_API_KEY for the BYOK provider key
 *  (MIM-74) — the key reaches the binary through the environment without
 *  entering the chat transcript or the process argv. */
const envProviderApiKey = () => {
  const key = process.env.MIMIR_PROVIDER_API_KEY;
  return key ? key : undefined;
};

/**
 * Parse install args — same as the partial parser but with serverUrl
 * required. Install is the fresh-install path so there's nothing to
 * recover; the URL must be on the command line.
 */
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
  };
  return result;
};

/**
 * Build the InstallOptions for an `update` invocation by layering the
 * partial CLI args over the existing config.json. The result preserves
 * any field that wasn't explicitly overridden, so `update` with no
 * args is a true no-op refresh — same URL, same cartographer path,
 * same user-memory DB — and `update <url>` keeps the existing
 * cartographer and DB while only changing the URL.
 *
 * URL precedence: CLI flag > config.json > mcp.json (legacy fallback
 * for pre-config.json installs).
 *
 * API key precedence: CLI flag > MIMIR_API_KEY env > config.json —
 * env over config matches authHeaders(), so a key rotated via the
 * environment takes effect without editing config.json first.
 */
export const mergeUpdateOptions = async (partial: PartialOptions) => {
  const existing = await readConfig();
  const legacyUrl = existing ? undefined : await readUrlFromExistingMcpConfig();

  const serverUrl = partial.serverUrl ?? existing?.serverUrl ?? legacyUrl;
  if (!serverUrl) {
    return {
      error:
        "No URL provided and no existing config to recover from.\n" +
        "Run: mimir-cc update <mimir-server-url>",
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

  const merged: InstallOptions = {
    serverUrl,
    ...(userMemoryDb ? { userMemoryDb } : {}),
    ...(cartographerBinary ? { cartographerBinary } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(providerApiKey ? { providerApiKey } : {}),
    ...(provider ? { provider } : {}),
    ...(smallModel ? { smallModel } : {}),
  };
  return merged;
};
