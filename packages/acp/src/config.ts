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
  /**
   * Cap on conversation turns inside a single SDK `query()`. Forwarded as
   * the SDK's `maxTurns`. Undefined leaves the SDK's own default in place;
   * set via `MIMIR_CC_MAX_TURNS` to bound runaway tool loops.
   */
  readonly maxTurns?: number;
  /**
   * USD spend cap inside a single SDK `query()`. Forwarded as the SDK's
   * `maxBudgetUsd` — query stops with `error_max_budget_usd` once exceeded.
   * Undefined disables the cap; set via `MIMIR_CC_MAX_BUDGET_USD`.
   */
  readonly maxBudgetUsd?: number;
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
  /**
   * Filesystem path for the ACP log file. Lines are appended to this file
   * in addition to being written to stderr. Empty string disables file
   * logging. Default: `~/.mimir/acp.log`.
   */
  readonly acpLogPath: string;
  readonly autoApproveTools: boolean;
  readonly systemPromptTtlMs: number;
  readonly cc: CCBackendConfig;
  readonly copilot: CopilotBackendConfig;
  readonly cartographer: CartographerConfig;
};

// Tools removed from the model's context to keep the per-turn prompt small.
// `disallowedTools` is the lever for hard removal — the SDK strips these from
// the tool definitions sent to the API. Anything kept here costs tokens every
// turn for its name + description + schema.
//   - Agent / Task: subagent dispatch, not used (we don't run subagents)
//   - WebFetch / WebSearch: superseded by mimir MCP's web_search tool
//   - NotebookRead / NotebookEdit: Jupyter, not in scope
//   - The remaining entries (worktree, cron, monitor, askUserQuestion,
//     scheduleWakeup, remoteTrigger) are CC features we don't surface.
const DEFAULT_DISALLOWED = [
  "Agent",
  "Task",
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
  "NotebookRead",
  "WebFetch",
  "WebSearch",
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

/**
 * Parse a boolean env var. Unset → `defaultValue`; "true"/"1" → true;
 * anything else → false. Folds the prior `parseEnabled` + `?? true` pattern
 * into a single call.
 */
const parseBool = (raw: string | undefined, defaultValue: boolean) =>
  raw === undefined ? defaultValue : raw === "true" || raw === "1";

/**
 * Parse a positive number from an env var. Returns undefined when the
 * variable is unset, empty, or not a finite positive number — keeping the
 * SDK option absent in those cases rather than passing through a bogus
 * value.
 */
const parsePositiveNumber = (raw: string | undefined) => {
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

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
      process.env.MIMIR_ACP_LOG_FILE ?? "~/.mimir/acp.log",
    ),
    autoApproveTools: process.env.AUTO_APPROVE_TOOLS === "true",
    systemPromptTtlMs: parseInt(
      process.env.MIMIR_SYSTEM_PROMPT_TTL ?? "300000",
      10,
    ),
    cc: {
      // Default to true; routing.ts disables it at startup if `claude` isn't on PATH.
      enabled: parseBool(process.env.MIMIR_CC_ENABLED, true),
      disallowedTools: parseDisallowed(process.env.MIMIR_CC_DISALLOWED_TOOLS),
      permissionMode:
        process.env.MIMIR_CC_PERMISSION_MODE ?? "bypassPermissions",
      workingDirectory: process.env.MIMIR_CC_WORKING_DIR,
      models: { ...DEFAULT_CC_MODELS },
      anchorInterval: parseInt(process.env.ANCHOR_INTERVAL ?? "20", 10),
      systemPromptPath: process.env.MIMIR_SYSTEM_PROMPT_PATH,
      maxTurns: parsePositiveNumber(process.env.MIMIR_CC_MAX_TURNS),
      maxBudgetUsd: parsePositiveNumber(process.env.MIMIR_CC_MAX_BUDGET_USD),
    },
    copilot: {
      enabled: parseBool(process.env.MIMIR_COPILOT_ENABLED, true),
      defaultModel: process.env.MIMIR_COPILOT_DEFAULT_MODEL ?? "gpt-5",
      workingDirectory: process.env.MIMIR_COPILOT_WORKING_DIR,
    },
    cartographer: {
      enabled: parseBool(process.env.MIMIR_CARTOGRAPHER_ENABLED, true),
      binaryPath: process.env.MIMIR_CARTOGRAPHER_BIN ?? "cartographer",
    },
  };
  return config;
};

export const config = loadConfig();
