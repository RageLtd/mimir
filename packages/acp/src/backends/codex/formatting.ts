/**
 * Codex app-server option builders.
 */

import type { McpServer } from "@agentclientprotocol/sdk";
import type { ThoughtLevel } from "../../agent/types";
import {
  DEFAULT_CODEX_THOUGHT_LEVEL,
  resolveCodexMode,
} from "./config-options";
import { buildCodexMcpServers } from "./mcp-config";
import type { ReasoningEffort } from "./protocol/ReasoningEffort";
import type { JsonValue } from "./protocol/serde_json/JsonValue";
import type { AskForApproval } from "./protocol/v2/AskForApproval";
import type { SandboxMode } from "./protocol/v2/SandboxMode";

export type CodexConfig = {
  [key: string]: JsonValue;
};

export type CodexThreadOptions = {
  readonly model: string;
  readonly workingDirectory: string;
  readonly sandboxMode: SandboxMode;
  readonly approvalPolicy: AskForApproval;
  readonly modelReasoningEffort: ReasoningEffort;
};

export type RunCodexOptions = {
  readonly prompt: string;
  readonly instructionPath: string;
  readonly workingDirectory: string;
  readonly serverUrl: string;
  readonly userMemoryDbPath: string;
  readonly model: string;
  readonly clientMcpServers?: readonly McpServer[];
  readonly mode?: string;
  readonly effort?: ThoughtLevel;
  readonly signal?: AbortSignal;
};

export const isCodexEffort = (effort: ThoughtLevel | undefined) =>
  effort === "minimal" ||
  effort === "low" ||
  effort === "medium" ||
  effort === "high" ||
  effort === "xhigh";

export const resolveCodexEffort = (effort: ThoughtLevel | undefined) =>
  isCodexEffort(effort) ? effort : DEFAULT_CODEX_THOUGHT_LEVEL;

export const buildCodexOptions = (
  options: Pick<
    RunCodexOptions,
    | "instructionPath"
    | "serverUrl"
    | "userMemoryDbPath"
    | "workingDirectory"
    | "clientMcpServers"
  >,
) => {
  const config = {
    model_instructions_file: options.instructionPath,
    mcp_servers: buildCodexMcpServers(
      options.serverUrl,
      options.userMemoryDbPath,
      options.workingDirectory,
      options.clientMcpServers,
    ),
  } satisfies CodexConfig;
  return { config };
};

export const buildCodexThreadOptions = (
  options: Pick<
    RunCodexOptions,
    "workingDirectory" | "model" | "mode" | "effort"
  >,
) => {
  const mode = resolveCodexMode(options.mode);
  return {
    model: options.model,
    workingDirectory: options.workingDirectory,
    sandboxMode: mode.sandboxMode,
    approvalPolicy: mode.approvalPolicy,
    modelReasoningEffort: resolveCodexEffort(options.effort),
  } satisfies CodexThreadOptions;
};
