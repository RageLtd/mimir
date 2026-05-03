/**
 * Claude Code backend adapter.
 *
 * Bridges the generic Backend interface to `runClaudeCode`. This is the
 * entry point for the backend router — swapping to a different SDK or CLI
 * means creating a new adapter with the same BackendRunOptions → BackendEvent
 * async generator contract.
 */

import type { CCBackendConfig } from "../../config";
import { getCCModelFlag, isCCModel } from "../../routing";
import type { Backend, BackendRunOptions } from "../types";
import { runClaudeCode } from "./runner";

export type ClaudeCodeBackendDeps = {
  readonly cc: CCBackendConfig;
  /** The mimir-server URL, forwarded into per-invocation MCP configs. */
  readonly serverUrl: string;
  /** Path to the user memory SQLite database, forwarded to the MCP server config. */
  readonly userMemoryDbPath: string;
  /** Default cwd when ACP doesn't supply a project path. */
  readonly defaultCwd: string;
};

export const createClaudeCodeBackend = (deps: ClaudeCodeBackendDeps) => {
  const run = async function* (options: BackendRunOptions) {
    const cwd =
      deps.cc.workingDirectory ?? options.projectPath ?? deps.defaultCwd;

    const model = isCCModel(options.modelId)
      ? getCCModelFlag(options.modelId, deps.cc)
      : undefined;

    yield* runClaudeCode({
      prompt: options.prompt,
      promptBlocks: options.promptBlocks,
      systemPrompt: options.systemPrompt,
      workingDirectory: cwd,
      cc: deps.cc,
      serverUrl: deps.serverUrl,
      userMemoryDbPath: deps.userMemoryDbPath,
      model,
      clientMcpServers: options.clientMcpServers,
      bootServer: options.bootServer,
      permissionMode: options.permissionMode,
      effort: options.effort,
      rules: options.rules,
      signal: options.signal,
    });
  };

  return { kind: "claude-code" as const, run } satisfies Backend;
};
