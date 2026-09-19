import { attemptSync } from "@mimir/plugin-core/result";
import { fail, ok } from "../result.ts";

export const BASH_TOOL = "Bash";
const SUMMARY_MAX = 200;

/** What the agent wants to run, as posted by the worker's canUseTool. */
export type PermissionRequest = {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  /** The tool call's own `description` field, when the tool carries one. */
  reasoning?: string;
  /** The harness's explanation of why this call needed a prompt. */
  decisionReason?: string;
};

export type PermissionDecision = "allow" | "allow-always" | "deny";

/** `{ tool }` allows every call of that tool; Bash rules pin an exact command. */
export type AllowRule = { tool: string; command?: string };

/** Shell metacharacters that join or nest commands. */
const COMPOUND_PATTERN = /[|&;`\n]|\$\(/;

export const isCompound = (command: string) => COMPOUND_PATTERN.test(command);

export const commandOf = (request: PermissionRequest) =>
  request.toolName === BASH_TOOL && typeof request.input.command === "string"
    ? request.input.command
    : undefined;

/** Allow-always is offered for non-Bash tools and for simple Bash commands. */
export const eligibleForAlways = (request: PermissionRequest) => {
  const command = commandOf(request);
  return command === undefined
    ? request.toolName !== BASH_TOOL
    : !isCompound(command);
};

export const ruleFor = (request: PermissionRequest) => {
  if (!eligibleForAlways(request)) {
    return undefined;
  }
  const command = commandOf(request);
  return command === undefined
    ? { tool: request.toolName }
    : { tool: request.toolName, command: command.trim() };
};

export const matchesRule = (rule: AllowRule, request: PermissionRequest) => {
  if (rule.tool !== request.toolName) {
    return false;
  }
  if (rule.command === undefined) {
    return request.toolName !== BASH_TOOL;
  }
  return commandOf(request)?.trim() === rule.command;
};

export const matchesAny = (rules: AllowRule[], request: PermissionRequest) =>
  rules.some((rule) => matchesRule(rule, request));

export const sameRule = (a: AllowRule, b: AllowRule) =>
  a.tool === b.tool && a.command === b.command;

/** One-line rendering of the tool input for the prompt and transcript. */
export const summarize = (request: PermissionRequest) => {
  const { input } = request;
  const command = commandOf(request);
  if (command !== undefined) {
    return command;
  }
  for (const key of ["file_path", "path", "pattern", "url", "query"]) {
    const value = input[key];
    if (typeof value === "string") {
      return value;
    }
  }
  const json = JSON.stringify(input);
  return json.length > SUMMARY_MAX ? `${json.slice(0, SUMMARY_MAX)}…` : json;
};

const isRecord = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** File shape: `[[allow]]` tables with `tool` and optional `command`. */
export const validateRules = (raw: unknown) => {
  if (!isRecord(raw)) {
    return fail<AllowRule[]>("permissions root must be a table");
  }
  const allow = (raw as Record<string, unknown>).allow ?? [];
  if (!Array.isArray(allow)) {
    return fail<AllowRule[]>("allow: expected an array of tables");
  }
  const rules: AllowRule[] = [];
  for (const [index, entry] of allow.entries()) {
    if (!isRecord(entry)) {
      return fail<AllowRule[]>(`allow[${index}]: expected a table`);
    }
    const { tool, command } = entry as Record<string, unknown>;
    if (typeof tool !== "string" || tool === "") {
      return fail<AllowRule[]>(`allow[${index}].tool: expected a string`);
    }
    if (command !== undefined && typeof command !== "string") {
      return fail<AllowRule[]>(`allow[${index}].command: expected a string`);
    }
    rules.push(command === undefined ? { tool } : { tool, command });
  }
  return ok(rules);
};

export const parseRules = (text: string) => {
  const [error, parsed] = attemptSync(() => Bun.TOML.parse(text));
  if (error !== null) {
    return fail<AllowRule[]>(`malformed TOML: ${error.message}`);
  }
  return validateRules(parsed);
};

export const stringifyRules = (rules: AllowRule[]) =>
  Bun.TOML.stringify({ allow: rules }) ?? "";
