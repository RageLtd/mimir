/**
 * Codex backend adapter.
 *
 * One Codex Thread is held per ACP session and reused across turns. Codex owns
 * its local tool loop; Mimir observes normalized events for ACP rendering.
 */

import { getCodexModelFlag } from "../../routing";
import type { Backend, BackendRunOptions } from "../types";
import { createCodexThread, runCodexThread } from "./runner";

export type CodexBackendDeps = {
  readonly serverUrl: string;
  readonly userMemoryDbPath: string;
  readonly defaultCwd: string;
};

const requireSession = (options: BackendRunOptions) => {
  if (!options.session) {
    throw new Error(
      "codex backend requires options.session — caller must pass SessionState through BackendRunOptions",
    );
  }
  return options.session;
};

export const createCodexBackend = (deps: CodexBackendDeps) => {
  const run = async function* (options: BackendRunOptions) {
    const session = requireSession(options);
    const cwd = options.projectPath ?? deps.defaultCwd;
    const instructionPath = session.codexInstructionPath;
    if (!instructionPath) {
      throw new Error(
        "codex backend requires session.codexInstructionPath — prompt path must write instructions before running",
      );
    }

    const model = getCodexModelFlag(options.modelId);
    const mode = options.permissionMode ?? session.currentMode;

    if (
      session.codexThread &&
      session.codexThreadConfig &&
      (session.codexThreadConfig.modelId !== options.modelId ||
        session.codexThreadConfig.mode !== mode ||
        session.codexThreadConfig.effort !== options.effort)
    ) {
      session.codexThread = null;
      session.codexThreadConfig = null;
    }

    if (!session.codexThread) {
      session.codexThread = createCodexThread({
        prompt: options.prompt,
        instructionPath,
        workingDirectory: cwd,
        serverUrl: deps.serverUrl,
        userMemoryDbPath: deps.userMemoryDbPath,
        model,
        clientMcpServers: options.clientMcpServers,
        permissionBridge: session.codexPermissionBridge,
        mode,
        effort: options.effort,
        signal: options.signal,
      });
      session.codexThreadConfig = {
        modelId: options.modelId,
        mode,
        effort: options.effort,
      };
    }

    yield* runCodexThread(session.codexThread, options.prompt, options.signal);
  };

  return { kind: "codex" as const, run } satisfies Backend;
};
