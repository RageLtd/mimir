/**
 * Configuration for mimir-acp.
 * Reads from environment variables with sensible defaults.
 *
 * Every model routes through mimir-server; there is no per-backend switch.
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
  readonly model: string;
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
  readonly systemPromptTtlMs: number;
  readonly cartographer: CartographerConfig;
};

/**
 * Parse a boolean env var. Unset → `defaultValue`; "true"/"1" → true;
 * anything else → false.
 */
const parseBool = (raw: string | undefined, defaultValue: boolean) =>
  raw === undefined ? defaultValue : raw === "true" || raw === "1";

export const loadConfig = () => {
  const config: MimirConfig = {
    serverUrl: process.env.MIMIR_SERVER_URL ?? "http://mimir.conhost.lan",
    apiKey: process.env.MIMIR_API_KEY ?? "",
    model: process.env.MIMIR_MODEL ?? "openrouter/auto",
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
    systemPromptTtlMs: parseInt(
      process.env.MIMIR_SYSTEM_PROMPT_TTL ?? "300000",
      10,
    ),
    cartographer: {
      enabled: parseBool(process.env.MIMIR_CARTOGRAPHER_ENABLED, true),
      binaryPath: process.env.MIMIR_CARTOGRAPHER_BIN ?? "cartographer",
    },
  };
  return config;
};

export const config = loadConfig();
