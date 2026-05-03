/**
 * Copilot backend adapter.
 *
 * Bridges the generic Backend interface to `runCopilot`. Same contract
 * as the Claude Code adapter — BackendRunOptions in, BackendEvent stream out.
 * Swapping between CC and Copilot is transparent to the prompt path.
 */

import type { CopilotBackendConfig } from "../../config";
import { COPILOT_PREFIX } from "../../routing";
import type { Backend, BackendEvent, BackendRunOptions } from "../types";
import { runCopilot } from "./runner";

export type CopilotBackendDeps = {
  readonly copilot: CopilotBackendConfig;
  readonly serverUrl: string;
  readonly userMemoryDbPath: string;
  readonly defaultCwd: string;
};

export const createCopilotBackend = (deps: CopilotBackendDeps): Backend => {
  const run = async function* (
    options: BackendRunOptions,
  ): AsyncGenerator<BackendEvent> {
    const cwd =
      deps.copilot.workingDirectory ?? options.projectPath ?? deps.defaultCwd;

    // Strip the copilot/ prefix to get the SDK model id.
    const model = options.modelId.startsWith(COPILOT_PREFIX)
      ? options.modelId.slice(COPILOT_PREFIX.length)
      : undefined;

    yield* runCopilot({
      prompt: options.prompt,
      promptBlocks: options.promptBlocks,
      // Pre-assembled context messages are no longer threaded through
      // BackendRunOptions; if Copilot needs the equivalent of CC's
      // first-turn `assembleContext`, wire it inside this adapter.
      contextMessages: [],
      systemPrompt: options.systemPrompt,
      workingDirectory: cwd,
      copilot: deps.copilot,
      serverUrl: deps.serverUrl,
      userMemoryDbPath: deps.userMemoryDbPath,
      model,
      clientMcpServers: options.clientMcpServers,
      signal: options.signal,
    });
  };

  return { kind: "copilot", run };
};
