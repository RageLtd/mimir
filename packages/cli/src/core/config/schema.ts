import { attemptSync } from "@mimir/plugin-core/result";
import {
  COLOR_HINT,
  DEFAULT_ACCENT,
  DEFAULT_MUTED,
  isColor,
} from "../colors.ts";
import { fail, ok } from "../result.ts";

export const PERMISSION_MODES = [
  "default",
  "acceptEdits",
  "plan",
  "bypassPermissions",
  "dontAsk",
  "auto",
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type CliConfig = {
  agent: {
    /** Claude Code model alias or id; absent = Claude Code's default. */
    model?: string;
    permissionMode: PermissionMode;
  };
  ui: {
    accent: string;
    muted: string;
  };
};

export const DEFAULT_CONFIG: CliConfig = {
  agent: { permissionMode: "default" },
  ui: { accent: DEFAULT_ACCENT, muted: DEFAULT_MUTED },
};

const isRecord = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown) =>
  isRecord(value) ? (value as Record<string, unknown>) : {};

const asPermissionMode = (value: unknown) =>
  PERMISSION_MODES.find((mode) => mode === value);

const permissionModeError = `agent.permissionMode: expected one of ${PERMISSION_MODES.join(", ")}`;

/** Optional string field: absent is fine, any other type is an error. */
const readString = (table: Record<string, unknown>, key: string) => {
  const value = table[key];
  if (value === undefined || typeof value === "string") {
    return ok<string | undefined>(value);
  }
  return fail<string | undefined>(`${key}: expected a string`);
};

const readColor = (table: Record<string, unknown>, key: string) => {
  const [error, value] = readString(table, key);
  if (error !== null || value === undefined || isColor(value)) {
    return [error, value] as const;
  }
  return fail<string | undefined>(`${key}: ${COLOR_HINT}`);
};

/** Validates a parsed TOML document, filling gaps from DEFAULT_CONFIG. */
export const validateConfig = (raw: unknown) => {
  if (!isRecord(raw)) {
    return fail<CliConfig>("config root must be a table");
  }
  const root = raw as Record<string, unknown>;
  const agent = asRecord(root.agent);
  const ui = asRecord(root.ui);

  const [modelError, model] = readString(agent, "model");
  if (modelError !== null) {
    return fail<CliConfig>(`agent.${modelError.message}`);
  }
  const permissionMode = asPermissionMode(
    agent.permissionMode ?? DEFAULT_CONFIG.agent.permissionMode,
  );
  if (permissionMode === undefined) {
    return fail<CliConfig>(permissionModeError);
  }
  const [accentError, accent] = readColor(ui, "accent");
  if (accentError !== null) {
    return fail<CliConfig>(`ui.${accentError.message}`);
  }
  const [mutedError, muted] = readColor(ui, "muted");
  if (mutedError !== null) {
    return fail<CliConfig>(`ui.${mutedError.message}`);
  }

  return ok<CliConfig>({
    agent: {
      ...(model === undefined ? {} : { model }),
      permissionMode,
    },
    ui: {
      accent: accent ?? DEFAULT_CONFIG.ui.accent,
      muted: muted ?? DEFAULT_CONFIG.ui.muted,
    },
  });
};

export const parseConfig = (text: string) => {
  const [error, parsed] = attemptSync(() => Bun.TOML.parse(text));
  if (error !== null) {
    return fail<CliConfig>(`malformed TOML: ${error.message}`);
  }
  return validateConfig(parsed);
};

export const stringifyConfig = (config: CliConfig) =>
  Bun.TOML.stringify(config) ?? "";

/**
 * Applies a dotted-path assignment (`agent.model`, `ui.accent`) from a string
 * value, as typed at the prompt. Returns the new config or why it was refused.
 */
export const setConfigPath = (
  config: CliConfig,
  path: string,
  value: string,
) => {
  switch (path) {
    case "agent.model":
      return ok<CliConfig>({
        ...config,
        agent: { ...config.agent, model: value },
      });
    case "agent.permissionMode": {
      const mode = asPermissionMode(value);
      return mode === undefined
        ? fail<CliConfig>(permissionModeError)
        : ok<CliConfig>({
            ...config,
            agent: { ...config.agent, permissionMode: mode },
          });
    }
    case "ui.accent":
    case "ui.muted": {
      if (!isColor(value)) {
        return fail<CliConfig>(`${path}: ${COLOR_HINT}`);
      }
      const key = path === "ui.accent" ? "accent" : "muted";
      return ok<CliConfig>({ ...config, ui: { ...config.ui, [key]: value } });
    }
    default:
      return fail<CliConfig>(`unknown config key: ${path}`);
  }
};
