/**
 * Configuration for mimir-acp.
 * Reads from environment variables with sensible defaults.
 *
 * Backend selection is per-request, driven by the model prefix:
 * `claude-code/*` routes to the Claude Code Agent SDK; everything else
 * routes to mimir-server. There is no global `backend` switch.
 */

const expandHome = (p: string) =>
  p.startsWith("~/") ? `${Bun.env.HOME}/${p.slice(2)}` : p;

export type CCBackendConfig = {
  /** When false, CC models are hidden from the model list and routing rejects them. */
  readonly enabled: boolean;
  readonly disallowedTools: readonly string[];
  readonly permissionMode: string;
  readonly workingDirectory?: string;
  /** Maps the suffix after `claude-code/` to CC's --model flag value. */
  readonly models: Readonly<Record<string, string>>;
  /** Turns between voice anchor injections. 0 disables the feature. */
  readonly anchorInterval: number;
  /** Path to the canonical system prompt markdown file. */
  readonly systemPromptPath?: string;
};

export type CopilotBackendConfig = {
  /** When false, Copilot models are hidden from the model list and routing rejects them. */
  readonly enabled: boolean;
  /** Fallback model when the requested suffix isn't in the discovered list. */
  readonly defaultModel: string;
  readonly workingDirectory?: string;
};

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
  readonly autoApproveTools: boolean;
  readonly systemPromptTtlMs: number;
  readonly cc: CCBackendConfig;
  readonly copilot: CopilotBackendConfig;
  readonly cartographer: CartographerConfig;
};

const DEFAULT_DISALLOWED = [
  "Agent",
  "AskUserQuestion",
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

const parseEnabled = (raw: string | undefined) => {
  if (raw === undefined) return undefined;
  return raw === "true" || raw === "1";
};

export const loadConfig = (): MimirConfig => {
  const ccEnabledOverride = parseEnabled(process.env.MIMIR_CC_ENABLED);
  return {
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
    autoApproveTools: process.env.AUTO_APPROVE_TOOLS === "true",
    systemPromptTtlMs: parseInt(
      process.env.MIMIR_SYSTEM_PROMPT_TTL ?? "300000",
      10,
    ),
    cc: {
      // Default to true; routing.ts disables it at startup if `claude` isn't on PATH.
      enabled: ccEnabledOverride ?? true,
      disallowedTools: parseDisallowed(process.env.MIMIR_CC_DISALLOWED_TOOLS),
      permissionMode:
        process.env.MIMIR_CC_PERMISSION_MODE ?? "bypassPermissions",
      workingDirectory: process.env.MIMIR_CC_WORKING_DIR,
      models: DEFAULT_CC_MODELS,
      anchorInterval: parseInt(process.env.ANCHOR_INTERVAL ?? "6", 10),
      systemPromptPath: process.env.MIMIR_SYSTEM_PROMPT_PATH,
    },
    copilot: {
      enabled: parseEnabled(process.env.MIMIR_COPILOT_ENABLED) ?? true,
      defaultModel: process.env.MIMIR_COPILOT_DEFAULT_MODEL ?? "gpt-5",
      workingDirectory: process.env.MIMIR_COPILOT_WORKING_DIR,
    },
    cartographer: {
      enabled: parseEnabled(process.env.MIMIR_CARTOGRAPHER_ENABLED) ?? true,
      binaryPath: process.env.MIMIR_CARTOGRAPHER_BIN ?? "cartographer",
    },
  };
};

export const config = loadConfig();
