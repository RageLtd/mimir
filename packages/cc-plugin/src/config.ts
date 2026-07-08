/**
 * Runtime config shared by hooks at ~/.mimir/config.json. Written once at
 * install time, read by the rules-hook, reindex-hook, and boot-context
 * paths — anything that needs to know the mimir-server URL, the cartographer
 * binary location, or the user-memory DB path without having to re-prompt
 * the developer.
 *
 * Out-of-band on purpose: separated from mcp.json (CC owns that file) and
 * settings.json (CC owns that file too). Mimir-cc owns config.json
 * exclusively, so we can extend the schema without colliding with CC.
 */

import { join } from "node:path";

import { mimirHome } from "@mimir/plugin-core/util";

export type MimirConfig = {
  readonly serverUrl: string;
  readonly userMemoryDb: string;
  /** Absolute path to the cartographer binary. Unset means reindex is disabled. */
  readonly cartographerBinary?: string;
  /** Static bearer key for the interim API gate (MIM-77). Unset for
   *  ungated self-hosted servers. */
  readonly apiKey?: string;
  /** BYOK provider key for the background inference the persist POST
   *  spawns server-side (MIM-74). Unset → the server's env small model. */
  readonly providerApiKey?: string;
  /** Provider id (models.dev key) paired with providerApiKey. */
  readonly provider?: string;
  /** Small/cheap model for the spawned background jobs (e.g.
   *  "anthropic/claude-haiku-4-5"). */
  readonly smallModel?: string;
  /** MIM-86 extraction trio: user-chosen OpenAI-compatible endpoint that
   *  runs local memory extraction/summarization. baseUrl is required for
   *  the local paths to activate; model falls back to smallModel, key to
   *  providerApiKey (keyless local endpoints need none). */
  readonly extractionBaseUrl?: string;
  readonly extractionModel?: string;
  readonly extractionApiKey?: string;
};

const optionalString = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const configPath = () => join(mimirHome(), "config.json");

export const writeConfig = async (config: MimirConfig) => {
  await Bun.write(configPath(), `${JSON.stringify(config, null, 2)}\n`);
};

export const readConfig = async (): Promise<MimirConfig | null> => {
  const file = Bun.file(configPath());
  if (!(await file.exists())) return null;
  try {
    const parsed = (await file.json()) as Partial<MimirConfig>;
    if (
      typeof parsed.serverUrl !== "string" ||
      typeof parsed.userMemoryDb !== "string"
    ) {
      return null;
    }
    const providerApiKey = optionalString(parsed.providerApiKey);
    const provider = optionalString(parsed.provider);
    const smallModel = optionalString(parsed.smallModel);
    const extractionBaseUrl = optionalString(parsed.extractionBaseUrl);
    const extractionModel = optionalString(parsed.extractionModel);
    const extractionApiKey = optionalString(parsed.extractionApiKey);
    return {
      serverUrl: parsed.serverUrl,
      userMemoryDb: parsed.userMemoryDb,
      ...(typeof parsed.cartographerBinary === "string"
        ? { cartographerBinary: parsed.cartographerBinary }
        : {}),
      ...(typeof parsed.apiKey === "string" && parsed.apiKey.length > 0
        ? { apiKey: parsed.apiKey }
        : {}),
      ...(providerApiKey ? { providerApiKey } : {}),
      ...(provider ? { provider } : {}),
      ...(smallModel ? { smallModel } : {}),
      ...(extractionBaseUrl ? { extractionBaseUrl } : {}),
      ...(extractionModel ? { extractionModel } : {}),
      ...(extractionApiKey ? { extractionApiKey } : {}),
    };
  } catch {
    return null;
  }
};

/**
 * Authorization header for mimir-server calls (MIM-77 gate). Env var wins
 * over config.json so a key can be rotated per-session without a
 * reinstall; both unset → empty object, matching ungated servers.
 */
export const authHeaders = async () => {
  const key = process.env.MIMIR_API_KEY ?? (await readConfig())?.apiKey;
  // Built mutably so the inferred type is a uniform Record<string, string>
  // — a conditional-spread union trips fetch's HeadersInit overloads.
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
};

/**
 * BYOK provider credentials for the background inference a persist POST
 * spawns server-side (MIM-74). Env wins over config.json — the same
 * rotation-without-reinstall discipline as authHeaders(). Null when no
 * provider key is configured: the server uses its env small model.
 */
export const providerByok = async () => {
  const config = await readConfig();
  const apiKey = process.env.MIMIR_PROVIDER_API_KEY ?? config?.providerApiKey;
  if (!apiKey) return null;
  const provider = process.env.MIMIR_PROVIDER ?? config?.provider;
  const smallModel = process.env.MIMIR_SMALL_MODEL ?? config?.smallModel;
  return {
    apiKey,
    ...(provider ? { provider } : {}),
    ...(smallModel ? { smallModel } : {}),
  };
};

/**
 * MIM-86 extraction endpoint — the user-chosen model that distills
 * memories/summaries locally. Env wins over config.json (rotation without
 * reinstall). Fallback chain per Rage: model ← MIMIR_SMALL_MODEL/
 * config.smallModel; key ← MIMIR_PROVIDER_API_KEY/config.providerApiKey
 * (unset is fine — keyless local endpoints). Null (extraction skipped,
 * logged by callers) when baseUrl or model can't be resolved.
 */
export const extractionConfig = async () => {
  const config = await readConfig();
  const baseUrl =
    process.env.MIMIR_EXTRACTION_BASE_URL ?? config?.extractionBaseUrl;
  const model =
    process.env.MIMIR_EXTRACTION_MODEL ??
    config?.extractionModel ??
    process.env.MIMIR_SMALL_MODEL ??
    config?.smallModel;
  if (!baseUrl || !model) return null;
  const apiKey =
    process.env.MIMIR_EXTRACTION_API_KEY ??
    config?.extractionApiKey ??
    process.env.MIMIR_PROVIDER_API_KEY ??
    config?.providerApiKey;
  return { baseUrl, model, ...(apiKey ? { apiKey } : {}) };
};
