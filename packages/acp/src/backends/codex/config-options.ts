/**
 * Backend-native session config options for the Codex backend.
 *
 * Codex exposes sandbox access, approval policy, and model reasoning effort
 * as thread options. We surface a small mode selector with professional
 * defaults: project write access, with prompts for risky actions.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type {
  ApprovalMode,
  ModelReasoningEffort,
  SandboxMode,
} from "@openai/codex-sdk";

export type CodexMode = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly sandboxMode: SandboxMode;
  readonly approvalPolicy: ApprovalMode;
};

const DEFAULT_CODEX_MODE_CONFIG: CodexMode = {
  id: "default",
  name: "Default",
  description: "Edit the project and ask before untrusted commands.",
  sandboxMode: "workspace-write",
  approvalPolicy: "untrusted",
};

const CODEX_MODES: readonly CodexMode[] = [
  DEFAULT_CODEX_MODE_CONFIG,
  {
    id: "read-only",
    name: "Read Only",
    description: "Inspect and plan without modifying files.",
    sandboxMode: "read-only",
    approvalPolicy: "on-request",
  },
  {
    id: "auto",
    name: "Auto",
    description: "Edit the project without approval prompts.",
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
  },
];

export const DEFAULT_CODEX_MODE = "default";
export const DEFAULT_CODEX_THOUGHT_LEVEL = "high";

const CODEX_THOUGHT_LEVELS: readonly ModelReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

const CODEX_THOUGHT_DISPLAY: Record<ModelReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

export type CodexConfigOptionsContext = {
  readonly currentMode?: string;
  readonly currentThoughtLevel?: string;
};

export const modeOptions = () => CODEX_MODES;

export const resolveCodexMode = (modeId: string | undefined) =>
  CODEX_MODES.find((mode) => mode.id === modeId) ?? DEFAULT_CODEX_MODE_CONFIG;

export const isValidCodexMode = (id: string) =>
  CODEX_MODES.some((mode) => mode.id === id);

export const isValidCodexThoughtLevel = (
  level: string,
): level is ModelReasoningEffort =>
  (CODEX_THOUGHT_LEVELS as readonly string[]).includes(level);

export const buildCodexConfigOptions = (ctx: CodexConfigOptionsContext) => {
  const currentMode = resolveCodexMode(ctx.currentMode).id;
  const modeOption: acp.SessionConfigOption = {
    type: "select",
    id: "mode",
    name: "Mode",
    category: "mode",
    currentValue: currentMode,
    options: CODEX_MODES.map((mode) => ({
      value: mode.id,
      name: mode.name,
      description: mode.description,
    })),
  };

  const currentThoughtLevel =
    ctx.currentThoughtLevel && isValidCodexThoughtLevel(ctx.currentThoughtLevel)
      ? ctx.currentThoughtLevel
      : DEFAULT_CODEX_THOUGHT_LEVEL;

  const thoughtLevelOption: acp.SessionConfigOption = {
    type: "select",
    id: "thought_level",
    name: "Thought Level",
    category: "thought_level",
    currentValue: currentThoughtLevel,
    options: CODEX_THOUGHT_LEVELS.map((level) => ({
      value: level,
      name: CODEX_THOUGHT_DISPLAY[level],
    })),
  };

  return [modeOption, thoughtLevelOption];
};
