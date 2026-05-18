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
   * USD spend cap for the lifetime of the CC `Query`. The adapter creates
   * one Query per ACP session and reuses it across every turn via
   * streaming-input mode (see backends/claude-code/adapter.ts), so this
   * accumulates across the whole session — not per turn. Forwarded as the
   * SDK's `maxBudgetUsd`; query stops with `error_max_budget_usd` once
   * exceeded. Undefined disables the cap; set via `MIMIR_CC_MAX_BUDGET_USD`.
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

// Extras the CC backend should surface in the model selector ON TOP OF
// what the SDK's `supportedModels()` returns. The SDK advertises a
// short curated list (default/sonnet/haiku as of writing); these entries
// fill in things the SDK won't list but the underlying API accepts:
// specific Opus / Sonnet versions and the undocumented `opusplan`
// hybrid alias.
//
// Sourced against the Anthropic platform docs
// (https://platform.claude.com/docs/en/api/cli/messages) which lists
// `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6` as
// accepted model strings, plus the `opusplan` hybrid alias documented
// in https://code.claude.com/docs/en/model-config (uses opus during
// plan mode, switches to sonnet for execution — undocumented in the
// SDK's `supportedModels()` but accepted by `/model`).
//
// `claude-mythos-preview` is gated to a tiny set of security partners
// and intentionally omitted — listing it in the selector would dangle
// an unreachable option in front of every other user.
//
// The `[1m]` bracket suffix opts a model into its 1M-token long-context
// variant. Listed alongside the standard entry so the selector exposes
// both — the standard variant has a smaller window but cheaper input
// pricing under the 256k cliff, the 1M variant raises the ceiling at
// the higher tier rate. Users pick deliberately per session.
//
// Keys are the suffix shown in the selector (`claude-code/<key>`);
// values are the model string passed to the SDK's `model` option.
// Users can extend or replace via MIMIR_CC_EXTRA_MODELS.
const DEFAULT_CC_MODELS: Record<string, string> = {
  "opus-4-7": "claude-opus-4-7",
  "opus-4-6": "claude-opus-4-6",
  "opus-4-6-1m": "claude-opus-4-6[1m]",
  "sonnet-4-6": "claude-sonnet-4-6",
  opusplan: "opusplan",
};

/**
 * Parse `MIMIR_CC_EXTRA_MODELS` into a `<suffix>:<model>` map. Format:
 *
 *   MIMIR_CC_EXTRA_MODELS=opus-4-6:claude-opus-4-6,opus-snap:claude-opus-4-7-20251201
 *
 * Comma-separated entries; each entry is `<suffix>:<model>`. Whitespace
 * is trimmed. When unset, defaults to the curated `DEFAULT_CC_MODELS`
 * map. When set, REPLACES the defaults — set to an empty string to disable
 * extras entirely. Exported for unit testing.
 */
export const parseExtraModels = (raw: string | undefined) => {
  if (raw === undefined) return DEFAULT_CC_MODELS;
  if (raw.trim().length === 0) return {};
  const out: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) continue;
    const suffix = trimmed.slice(0, colon).trim();
    const model = trimmed.slice(colon + 1).trim();
    if (suffix.length === 0 || model.length === 0) continue;
    out[suffix] = model;
  }
  return out;
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
      models: parseExtraModels(process.env.MIMIR_CC_EXTRA_MODELS),
      anchorInterval: parseInt(process.env.ANCHOR_INTERVAL ?? "20", 10),
      systemPromptPath: process.env.MIMIR_SYSTEM_PROMPT_PATH,
      // Defaults bound the SDK's internal tool loop. `maxTurns` resets per
      // ACP prompt; `maxBudgetUsd` accumulates across the whole Query
      // lifetime (one Query per session — see backends/claude-code/adapter.ts)
      // so the budget ceiling is a session cap, not a per-turn cap. Without
      // these, a runaway loop has been observed at 40+ inner model calls /
      // 77M cumulative cached prompt tokens / $40+ in a single turn.
      maxTurns: parsePositiveNumber(process.env.MIMIR_CC_MAX_TURNS) ?? 50,
      maxBudgetUsd:
        parsePositiveNumber(process.env.MIMIR_CC_MAX_BUDGET_USD) ?? 25,
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
