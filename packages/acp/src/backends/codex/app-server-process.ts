import type { CodexAppServerTurnOptions } from "../../agent/types";
import { errMessage } from "../../util";
import { createChildLogger, log } from "../../utils/log";
import type { AppServerApprovalHandler } from "./app-server-approvals";
import { createCodexAppServerRpc } from "./app-server-rpc";
import { runCodexAppServerTurn } from "./app-server-runner";
import {
  initializeCodexAppServer,
  startCodexAppServerThread,
} from "./app-server-session";
import type { RunCodexOptions } from "./formatting";

const logger = createChildLogger(log, "codex-app-server");

type WritableSink = {
  readonly write: (data: string | Uint8Array) => unknown;
  readonly flush: () => unknown;
  readonly end: () => unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isWritableSink = (value: unknown): value is WritableSink =>
  isRecord(value) &&
  typeof value.write === "function" &&
  typeof value.flush === "function" &&
  typeof value.end === "function";

const threadIdFromStartResponse = (value: unknown) => {
  if (!isRecord(value)) return null;
  const thread = value.thread;
  if (!isRecord(thread)) return null;
  return typeof thread.id === "string" ? thread.id : null;
};

async function* textChunks(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    yield decoder.decode(chunk, { stream: true });
  }
  const rest = decoder.decode();
  if (rest.length > 0) yield rest;
}

export const startCodexAppServerProcess = () => {
  const proc = Bun.spawn(["codex", "app-server", "--listen", "stdio://"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });

  if (!(proc.stdout instanceof ReadableStream)) {
    proc.kill();
    throw new Error("codex app-server did not expose stdout as a stream");
  }
  if (!isWritableSink(proc.stdin)) {
    proc.kill();
    throw new Error("codex app-server did not expose stdin as a writable sink");
  }

  const stdin = proc.stdin;
  const transport = {
    incoming: textChunks(proc.stdout),
    write(data: string) {
      stdin.write(data);
      stdin.flush();
    },
    async close() {
      stdin.end();
      proc.kill();
      await proc.exited.catch((err) =>
        logger.debug(
          "codex app-server process exit wait failed: %s",
          errMessage(err),
        ),
      );
    },
  };

  const rpc = createCodexAppServerRpc(transport);
  return { rpc, exited: proc.exited };
};

export const createCodexAppServerState = async (
  options: RunCodexOptions,
  approvalHandler: AppServerApprovalHandler,
) => {
  const appProcess = startCodexAppServerProcess();
  await initializeCodexAppServer(appProcess.rpc);
  const startResponse = await startCodexAppServerThread(
    appProcess.rpc,
    options,
  );
  const threadId = threadIdFromStartResponse(startResponse);
  if (!threadId) {
    await appProcess.rpc.close();
    throw new Error(
      "codex app-server thread/start response did not include thread.id",
    );
  }

  return {
    threadId,
    async close() {
      await appProcess.rpc.close();
    },
    runTurn(turnOptions: CodexAppServerTurnOptions) {
      return runCodexAppServerTurn(
        { rpc: appProcess.rpc, threadId, approvalHandler },
        turnOptions,
      );
    },
  };
};
