/**
 * OpenCode plugin config loader.
 *
 * Reads the same `~/.mimir/config.json` the cc-plugin writes. The shape
 * matches the cc-plugin's `MimirConfig` exactly — both plugins share
 * the same on-disk state so users with both installed get one config
 * to edit. The `MIMIR_HOME` env override (used by tests) is honoured.
 *
 * `MIMIR_API_KEY` env takes precedence over `config.apiKey` so a key
 * can be rotated per-session without a reinstall. `MIMIR_PROVIDER_*`
 * env vars win over their config counterparts for the same reason.
 *
 * The oc-plugin and the cc-plugin both own this same config — the type
 * and on-disk schema are intentionally identical. Duplication is
 * acceptable here; the alternative (lifting into plugin-core) would
 * couple the shared layer to a specific filesystem path.
 */

import { join } from "node:path";

import { errMessage, mimirHome } from "@mimir/plugin-core/util";

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
};

const optionalString = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const configPath = () => join(mimirHome(), "config.json");

export const writeConfig = async (config: MimirConfig): Promise<void> => {
  await Bun.write(configPath(), `${JSON.stringify(config, null, 2)}\n`);
};

/**
 * Read the persisted config. Returns null when the file is missing or
 * malformed — the plugin entry treats null as "not yet installed" and
 * emits a helpful error at first use.
 */
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
    };
  } catch (err) {
    // Malformed JSON or unreadable file — log and treat as unconfigured.
    // Plugin entry will surface a useful error to the user.
    console.error(`${errMessage(err)}: failed to read ${configPath()}`);
    return null;
  }
};

/**
 * Authorization header for mimir-server calls (MIM-77). Env var wins
 * over config.json so a key can be rotated per-session without a
 * reinstall. Returns empty object when neither is set (ungated servers).
 */
export const authHeaders = async () => {
  const key = process.env.MIMIR_API_KEY ?? (await readConfig())?.apiKey;
  const headers: Record<string, string> = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
};

/**
 * BYOK provider credentials (MIM-74/MIM-75). Env wins over config.json —
 * the same rotation-without-reinstall discipline as authHeaders(). Null
 * when no provider key is configured: the server uses its env models.
 * Mirrors cc-plugin's providerByok exactly.
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
