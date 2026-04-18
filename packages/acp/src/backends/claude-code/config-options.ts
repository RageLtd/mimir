/**
 * Backend-native session config options for the Claude Code backend.
 *
 * Exposes the SDK's `PermissionMode` union as a mode selector and the
 * per-model `supportedEffortLevels` as a thought-level selector. Both are
 * advertised via ACP's `SessionConfigOption[]` in session responses so
 * Zed renders each as a distinct UI element based on its category.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type {
  EffortLevel,
  PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import { supportedEffortLevels } from "./model-capabilities";

/** Safe, user-pickable CC permission modes. `bypassPermissions` is added conditionally. */
const BASE_MODES: {
  readonly id: PermissionMode;
  readonly name: string;
  readonly description: string;
}[] = [
  {
    id: "default",
    name: "Default",
    description: "Standard permission behaviour — prompts on dangerous operations.",
  },
  {
    id: "acceptEdits",
    name: "Accept Edits",
    description: "Auto-accept file edits without prompting.",
  },
  {
    id: "plan",
    name: "Plan",
    description: "Planning mode — no tool execution.",
  },
  {
    id: "dontAsk",
    name: "Don't Ask",
    description: "Don't prompt for permissions; deny if not pre-approved.",
  },
  {
    id: "auto",
    name: "Auto",
    description: "Auto-approve tool actions.",
  },
];

const BYPASS_MODE: { id: PermissionMode; name: string; description: string } = {
  id: "bypassPermissions",
  name: "Bypass Permissions",
  description:
    "Skip all permission checks (requires deploy-time opt-in via MIMIR_CC_PERMISSION_MODE).",
};

export const DEFAULT_CC_MODE: PermissionMode = "default";
export const DEFAULT_CC_THOUGHT_LEVEL: EffortLevel = "high";

const EFFORT_DISPLAY: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

export type CCConfigOptionsContext = {
  /** Resolved CLI alias (e.g. "opus", "sonnet[1m]"). */
  readonly modelAlias?: string;
  /** Currently-selected mode, defaults to `DEFAULT_CC_MODE`. */
  readonly currentMode?: string;
  /** Currently-selected thought level, defaults to `DEFAULT_CC_THOUGHT_LEVEL`. */
  readonly currentThoughtLevel?: string;
  /**
   * True when the startup config already opted into `bypassPermissions`.
   * When false, the mode is hidden from the dropdown to avoid the footgun
   * of click-to-bypass undoing the SDK's intentional safety gate.
   */
  readonly bypassPermissionsAllowed: boolean;
};

export const buildCCConfigOptions = (
  ctx: CCConfigOptionsContext,
): acp.SessionConfigOption[] => {
  const modes = ctx.bypassPermissionsAllowed
    ? [...BASE_MODES, BYPASS_MODE]
    : BASE_MODES;

  const currentMode = ctx.currentMode ?? DEFAULT_CC_MODE;
  const modeOption: acp.SessionConfigOption = {
    type: "select",
    id: "mode",
    name: "Mode",
    category: "mode",
    currentValue: currentMode,
    options: modes.map((m) => ({
      value: m.id,
      name: m.name,
      description: m.description,
    })),
  };

  const efforts = supportedEffortLevels(ctx.modelAlias);
  if (efforts.length === 0) {
    return [modeOption];
  }

  const currentThoughtLevel =
    ctx.currentThoughtLevel && efforts.includes(ctx.currentThoughtLevel as EffortLevel)
      ? ctx.currentThoughtLevel
      : efforts.includes(DEFAULT_CC_THOUGHT_LEVEL)
        ? DEFAULT_CC_THOUGHT_LEVEL
        : efforts[0];

  const thoughtLevelOption: acp.SessionConfigOption = {
    type: "select",
    id: "thought_level",
    name: "Thought Level",
    category: "thought_level",
    currentValue: currentThoughtLevel as string,
    options: efforts.map((level) => ({
      value: level,
      name: EFFORT_DISPLAY[level],
    })),
  };

  return [modeOption, thoughtLevelOption];
};

/** Is the given string a valid CC permission mode id (including `bypassPermissions`)? */
export const isValidCCMode = (id: string): id is PermissionMode => {
  return (
    BASE_MODES.some((m) => m.id === id) || id === BYPASS_MODE.id
  );
};

/** Is the given string a valid effort level for the active model? */
export const isValidThoughtLevel = (
  level: string,
  modelAlias: string | undefined,
): level is EffortLevel => {
  const efforts = supportedEffortLevels(modelAlias);
  return (efforts as readonly string[]).includes(level);
};
