/**
 * Shared runtime config at ~/.mimir/config.json — written once at install
 * time by whichever distribution installs first (cc-plugin, oc-plugin,
 * codex-plugin), read by every hook and command that needs the
 * mimir-server URL, cartographer binary location, memory DB paths, or
 * BYOK/extraction credentials without re-prompting the developer.
 *
 * Hoisted from cc-plugin (MIM-87 rule: shared logic ships once in
 * plugin-core with thin per-distribution wiring). The keys/sync CLIs in
 * this package read the same file with their own narrower resolvers;
 * this module is the full-schema owner.
 *
 * Out-of-band on purpose: separated from editor-owned files (CC's
 * settings.json/mcp.json, Codex's config.toml). Mimir owns config.json
 * exclusively, so the schema can grow without colliding with any editor.
 */

import { join } from "node:path";

import { attempt } from "./result";
import { expandHomePath, mimirHome } from "./util";

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
  await Bun.write(
    configPath(),
    `${JSON.stringify(
      { ...config, userMemoryDb: expandHomePath(config.userMemoryDb) },
      null,
      2,
    )}\n`,
  );
};

export const readConfig = async () => {
  const file = Bun.file(configPath());
  if (!(await file.exists())) return null;
  // Malformed JSON degrades to "no config" — every caller treats null as
  // the unconfigured state and logs its own skip, so the parse error is
  // surfaced at the decision site rather than thrown here.
  const [parseErr, parsed] = await attempt(
    async () => (await file.json()) as Partial<MimirConfig>,
  );
  if (parseErr) return null;
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
    userMemoryDb: expandHomePath(parsed.userMemoryDb),
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
