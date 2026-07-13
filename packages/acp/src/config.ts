/**
 * Configuration for mimir-acp.
 * Reads from environment variables with sensible defaults.
 *
 * Inference and project identity run locally on plugin-core; the server is
 * contacted only for the boot-time system prompt, keys, and encrypted sync.
 */

const expandHome = (p: string) =>
  p.startsWith("~/") ? `${Bun.env.HOME}/${p.slice(2)}` : p;

export type CartographerConfig = {
  /** Enable cartographer binary integration. */
  readonly enabled: boolean;
  /** Path to the cartographer binary. Falls back to PATH lookup. */
  readonly binaryPath: string;
  /** Environment variables for the cartographer process. */
  readonly env?: Record<string, string>;
};

export type MimirConfig = {
  readonly serverUrl: string;
  readonly apiKey: string;
  /** Configured default model, or empty string for "no preference". */
  readonly model: string;
  /** BYOK small model for server-side background jobs (MIM-74), or empty
   *  string for "use the turn's request model". */
  readonly smallModel: string;
  readonly userMemoryDbPath: string;
  readonly sessionDbPath: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  /**
   * Filesystem path for the ACP log file. Lines are appended to this file
   * in addition to being written to stderr. Empty string disables file
   * logging. Default: `~/.mimir/logs/acp.log`.
   */
  readonly acpLogPath: string;
  readonly autoApproveTools: boolean;
  readonly cartographer: CartographerConfig;
};

/**
 * Parse a boolean env var. Unset → `defaultValue`; "true"/"1" → true;
 * anything else → false.
 */
const parseBool = (raw: string | undefined, defaultValue: boolean) =>
  raw === undefined ? defaultValue : raw === "true" || raw === "1";

/**
 * MIM-86/89 extraction endpoint — the user-chosen OpenAI-compatible model
 * that distills memories and summarizes compaction windows locally. ACP
 * is env-only (configured through the editor's env block — no config.json
 * leg, unlike cc/oc): baseUrl ← MIMIR_EXTRACTION_BASE_URL, model ←
 * MIMIR_EXTRACTION_MODEL → MIMIR_SMALL_MODEL, key ←
 * MIMIR_EXTRACTION_API_KEY → MIMIR_PROVIDER_API_KEY (unset is fine —
 * keyless local endpoints). Null when baseUrl or model can't resolve;
 * callers skip and log.
 */
export const extractionConfig = () => {
  const baseUrl = process.env.MIMIR_EXTRACTION_BASE_URL;
  const model =
    process.env.MIMIR_EXTRACTION_MODEL ?? process.env.MIMIR_SMALL_MODEL;
  if (!baseUrl || !model) return null;
  const apiKey =
    process.env.MIMIR_EXTRACTION_API_KEY ?? process.env.MIMIR_PROVIDER_API_KEY;
  return { baseUrl, model, ...(apiKey ? { apiKey } : {}) };
};

export const loadConfig = () => {
  const config: MimirConfig = {
    serverUrl: process.env.MIMIR_SERVER_URL ?? "http://mimir.conhost.lan",
    apiKey: process.env.MIMIR_API_KEY ?? "",
    // Empty = no configured default. Model selection is left to the picker:
    // `buildModelsState` defaults to the first discovered model and Zed's
    // selector drives it from there. Avoids depending on a hardcoded default
    // that the server may not serve.
    model: process.env.MIMIR_MODEL ?? "",
    // BYOK (MIM-74): designated small/cheap model for the background jobs
    // a turn spawns server-side (extraction, compaction). Same var name as
    // the cc-plugin. Empty = unset → keyed turns run those jobs on the
    // request model instead.
    smallModel: process.env.MIMIR_SMALL_MODEL ?? "",
    userMemoryDbPath: expandHome(
      process.env.MIMIR_USER_MEMORY_DB ?? "~/.mimir/user-memories.db",
    ),
    sessionDbPath: expandHome(
      process.env.MIMIR_SESSION_DB ?? "~/.mimir/sessions.db",
    ),
    logLevel: (process.env.LOG_LEVEL as MimirConfig["logLevel"]) ?? "info",
    acpLogPath: expandHome(
      process.env.MIMIR_ACP_LOG_FILE ?? "~/.mimir/logs/acp.log",
    ),
    autoApproveTools: process.env.AUTO_APPROVE_TOOLS === "true",
    cartographer: {
      enabled: parseBool(process.env.MIMIR_CARTOGRAPHER_ENABLED, true),
      binaryPath: process.env.MIMIR_CARTOGRAPHER_BIN ?? "cartographer",
    },
  };
  return config;
};

export const config = loadConfig();
