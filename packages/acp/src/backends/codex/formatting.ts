/**
 * Codex SDK option builders.
 */

import type { McpServer } from "@agentclientprotocol/sdk";
import type {
  CodexOptions,
  ModelReasoningEffort,
  ThreadOptions,
} from "@openai/codex-sdk";
import type { ThoughtLevel } from "../../agent/types";
import {
  DEFAULT_CODEX_THOUGHT_LEVEL,
  resolveCodexMode,
} from "./config-options";
import { buildCodexMcpServers } from "./mcp-config";
import {
  buildCodexPermissionHookConfig,
  type CodexPermissionBridge,
} from "./permission-bridge";

export type RunCodexOptions = {
  readonly prompt: string;
  readonly instructionPath: string;
  readonly workingDirectory: string;
  readonly serverUrl: string;
  readonly userMemoryDbPath: string;
  readonly model: string;
  readonly clientMcpServers?: readonly McpServer[];
  readonly permissionBridge?: CodexPermissionBridge | null;
  readonly mode?: string;
  readonly effort?: ThoughtLevel;
  readonly signal?: AbortSignal;
};

export const isCodexEffort = (
  effort: ThoughtLevel | undefined,
): effort is ModelReasoningEffort =>
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
    "instructionPath" | "serverUrl" | "userMemoryDbPath" | "clientMcpServers"
  > & { readonly permissionBridge?: CodexPermissionBridge | null },
) => {
  const config: NonNullable<CodexOptions["config"]> = {
    model_instructions_file: options.instructionPath,
    mcp_servers: buildCodexMcpServers(
      options.serverUrl,
      options.userMemoryDbPath,
      options.clientMcpServers,
    ),
    ...buildCodexPermissionHookConfig(options.permissionBridge ?? null),
  };
  return { config } satisfies CodexOptions;
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
    skipGitRepoCheck: true,
  } satisfies ThreadOptions;
};
