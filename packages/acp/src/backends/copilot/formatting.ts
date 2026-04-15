/**
 * Context formatting and session option building for the Copilot backend.
 *
 * Mirrors the CC backend's formatting.ts — assembles the system prompt
 * and session configuration from the same inputs. The Copilot SDK uses
 * `systemMessage` with `mode: "replace"` for full prompt control, and
 * `mcpServers` for tool access.
 */

import type { ContentBlock, McpServer } from "@agentclientprotocol/sdk";
import type { CopilotBackendConfig } from "../../config";
import {
  buildCopilotMcpServers,
  type CopilotMcpServerConfig,
} from "./mcp-config";

/**
 * Format assembled context messages as structured text, identical to
 * the CC backend's formatContextForPrompt. Shared logic could be
 * extracted later; for now each backend owns its formatting.
 */
export const formatContextForPrompt = (
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
): string => {
  if (messages.length === 0) return "";
  const lines = messages.map(
    (m) => `[${m.role === "user" ? "User" : "Assistant"}]\n${m.content}`,
  );
  return `<conversation_context>\n${lines.join("\n\n")}\n</conversation_context>`;
};

export type RunCopilotOptions = {
  /** Current user prompt text. */
  readonly prompt: string;
  /** Raw ACP content blocks — Copilot SDK only supports text prompts for now. */
  readonly promptBlocks?: readonly ContentBlock[];
  /** Prior context messages appended to the system prompt. */
  readonly contextMessages: ReadonlyArray<{
    role: "user" | "assistant";
    content: string;
  }>;
  readonly systemPrompt: string;
  readonly workingDirectory: string;
  readonly copilot: CopilotBackendConfig;
  readonly serverUrl: string;
  readonly userMemoryDbPath: string;
  readonly model?: string;
  readonly clientMcpServers?: readonly McpServer[];
  readonly signal?: AbortSignal;
};

export type CopilotSessionOptions = {
  model: string;
  streaming: true;
  systemMessage: {
    mode: "replace";
    content: string;
  };
  workingDirectory: string;
  mcpServers: Record<string, CopilotMcpServerConfig>;
  onPermissionRequest: () => Promise<{ kind: "approved" }>;
};

/** Build the Copilot session options from runner options. */
export const buildCopilotSessionOptions = (
  options: Pick<
    RunCopilotOptions,
    | "contextMessages"
    | "systemPrompt"
    | "model"
    | "copilot"
    | "workingDirectory"
    | "serverUrl"
    | "userMemoryDbPath"
    | "clientMcpServers"
  >,
): CopilotSessionOptions => {
  const contextText = formatContextForPrompt(options.contextMessages);
  const fullSystemPrompt = contextText
    ? `${options.systemPrompt}\n\n${contextText}`
    : options.systemPrompt;

  return {
    model: options.model ?? options.copilot.defaultModel,
    streaming: true,
    systemMessage: {
      mode: "replace",
      content: fullSystemPrompt,
    },
    workingDirectory: options.workingDirectory,
    mcpServers: buildCopilotMcpServers(
      options.serverUrl,
      options.userMemoryDbPath,
      options.clientMcpServers,
    ),
    // Approve all tool executions — Mimir manages its own permission layer.
    onPermissionRequest: async () => ({ kind: "approved" as const }),
  };
};
