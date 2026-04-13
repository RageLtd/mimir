/**
 * Configuration for mimir-acp.
 * Reads from environment variables with sensible defaults.
 *
 * Backend selection is per-request, driven by the model prefix:
 * `claude-code/*` routes to the CC subprocess; everything else routes
 * to mimir-server. There is no global `backend` switch.
 */

export type CCBackendConfig = {
  /** When false, CC models are hidden from the model list and routing rejects them. */
  readonly enabled: boolean;
  readonly mcpConfigPath: string;
  readonly disallowedTools: readonly string[];
  readonly permissionMode: string;
  readonly workingDirectory?: string;
  /** Maps the suffix after `claude-code/` to CC's --model flag value. */
  readonly models: Readonly<Record<string, string>>;
};

export type CartographerConfig = {
  /** Enable cartographer binary integration. */
  readonly enabled: boolean;
  /** Path to the cartographer binary. Falls back to PATH lookup. */
  readonly binaryPath: string;
  /** Environment variables for the cartographer process. */
  readonly env: Record<string, string>;
};

export type MimirConfig = {
  readonly serverUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly userMemoryDbPath: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly autoApproveTools: boolean;
  readonly systemPromptTtlMs: number;
  readonly cc: CCBackendConfig;
  readonly cartographer: CartographerConfig;
};

const DEFAULT_DISALLOWED = [
  "Agent",
  "EnterWorktree",
  "ExitWorktree",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
  "Monitor",
  "RemoteTrigger",
  "NotebookEdit",
];

const DEFAULT_CC_MODELS: Record<string, string> = {
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
  "opus-1m": "opus[1m]",
  "sonnet-1m": "sonnet[1m]",
};

const parseDisallowed = (raw: string | undefined): string[] => {
  if (!raw) return DEFAULT_DISALLOWED;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

const parseEnabled = (raw: string | undefined): boolean | undefined => {
  if (raw === undefined) return undefined;
  return raw === "true" || raw === "1";
};

export const loadConfig = (): MimirConfig => {
  const ccEnabledOverride = parseEnabled(process.env.MIMIR_CC_ENABLED);
  return {
    serverUrl: process.env.MIMIR_SERVER_URL ?? "http://localhost:3777",
    apiKey: process.env.MIMIR_API_KEY ?? "",
    model: process.env.MIMIR_MODEL ?? "openrouter/auto",
    userMemoryDbPath: process.env.MIMIR_USER_MEMORY_DB ?? "user-memories.db",
    logLevel: (process.env.LOG_LEVEL as MimirConfig["logLevel"]) ?? "info",
    autoApproveTools: process.env.AUTO_APPROVE_TOOLS === "true",
    systemPromptTtlMs: parseInt(
      process.env.MIMIR_SYSTEM_PROMPT_TTL ?? "300000",
      10,
    ),
    cc: {
      // Default to true; routing.ts disables it at startup if `claude` isn't on PATH.
      enabled: ccEnabledOverride ?? true,
      mcpConfigPath: process.env.MIMIR_CC_MCP_CONFIG ?? "./mimir-mcp.json",
      disallowedTools: parseDisallowed(process.env.MIMIR_CC_DISALLOWED_TOOLS),
      permissionMode:
        process.env.MIMIR_CC_PERMISSION_MODE ?? "bypassPermissions",
      workingDirectory: process.env.MIMIR_CC_WORKING_DIR,
      models: DEFAULT_CC_MODELS,
    },
    cartographer: {
      enabled: parseEnabled(process.env.MIMIR_CARTOGRAPHER_ENABLED) ?? true,
      binaryPath: process.env.MIMIR_CARTOGRAPHER_BIN ?? "cartographer",
      env: {
        ...(process.env.SURREAL_URL
          ? { SURREAL_URL: process.env.SURREAL_URL }
          : {}),
        ...(process.env.SURREAL_USER
          ? { SURREAL_USER: process.env.SURREAL_USER }
          : {}),
        ...(process.env.SURREAL_PASS
          ? { SURREAL_PASS: process.env.SURREAL_PASS }
          : {}),
        ...(process.env.SURREAL_NS
          ? { SURREAL_NS: process.env.SURREAL_NS }
          : {}),
        ...(process.env.SURREAL_DB
          ? { SURREAL_DB: process.env.SURREAL_DB }
          : {}),
      },
    },
  };
};

export const config = loadConfig();
