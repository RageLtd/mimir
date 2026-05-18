/**
 * Codex backend adapter.
 *
 * One Codex app-server thread is held per ACP session and reused across turns.
 * Codex owns its local tool loop; Mimir observes normalized events for ACP
 * rendering.
 */

import type { CodexAppServerState } from "../../agent/types";
import { getCodexModelFlag } from "../../routing";
import type { Backend, BackendRunOptions } from "../types";
import {
  type AppServerApprovalHandler,
  createAppServerApprovalHandler,
} from "./app-server-approvals";
import { createCodexAppServerState } from "./app-server-process";
import type { RunCodexOptions } from "./formatting";

export type CodexBackendDeps = {
  readonly serverUrl: string;
  readonly userMemoryDbPath: string;
  readonly defaultCwd: string;
  readonly appServer?: {
    readonly start: (
      options: RunCodexOptions,
      approvalHandler: AppServerApprovalHandler,
    ) => Promise<CodexAppServerState>;
  };
};

const requireSession = (options: BackendRunOptions) => {
  if (!options.session) {
    throw new Error(
      "codex backend requires options.session — caller must pass SessionState through BackendRunOptions",
    );
  }
  return options.session;
};

const closeAppServer = async (session: ReturnType<typeof requireSession>) => {
  const appServer = session.codexAppServer;
  session.codexAppServer = null;
  await appServer?.close();
};

export const createCodexBackend = (deps: CodexBackendDeps) => {
  const appServer = deps.appServer ?? { start: createCodexAppServerState };

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
      session.codexThreadConfig &&
      (session.codexThreadConfig.modelId !== options.modelId ||
        session.codexThreadConfig.mode !== mode ||
        session.codexThreadConfig.effort !== options.effort)
    ) {
      await closeAppServer(session);
      session.codexThreadConfig = null;
    }

    const runOptions = {
      prompt: options.prompt,
      instructionPath,
      workingDirectory: cwd,
      serverUrl: deps.serverUrl,
      userMemoryDbPath: deps.userMemoryDbPath,
      model,
      clientMcpServers: options.clientMcpServers,
      mode,
      effort: options.effort,
      signal: options.signal,
    } satisfies RunCodexOptions;

    if (!session.codexAppServer) {
      const autoApprove = mode === "auto";
      const approvalHandler = createAppServerApprovalHandler(
        options.requestToolPermission,
        autoApprove,
      );
      session.codexAppServer = await appServer.start(
        runOptions,
        approvalHandler,
      );
      session.codexThreadConfig = {
        modelId: options.modelId,
        mode,
        effort: options.effort,
      };
    }

    if (session.codexAppServer) {
      yield* session.codexAppServer.runTurn({
        prompt: options.prompt,
        model,
        effort: options.effort,
        signal: options.signal,
      });
      return;
    }
  };

  return { kind: "codex" as const, run } satisfies Backend;
};
