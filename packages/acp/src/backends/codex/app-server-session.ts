import {
  buildCodexOptions,
  buildCodexThreadOptions,
  type RunCodexOptions,
  resolveCodexEffort,
} from "./formatting";

export type CodexAppServerRpcClient = {
  readonly request: (method: string, params: unknown) => Promise<unknown>;
  readonly notify: (method: string, params?: unknown) => Promise<void> | void;
};

const CLIENT_INFO = {
  name: "mimir-acp",
  title: "Mimir ACP",
  version: "0.0.0",
};

export const initializeCodexAppServer = async (
  rpc: CodexAppServerRpcClient,
) => {
  await rpc.request("initialize", {
    clientInfo: CLIENT_INFO,
    capabilities: {
      experimentalApi: true,
      optOutNotificationMethods: [],
    },
  });
  await rpc.notify("initialized");
};

const appServerConfig = (
  options: Pick<
    RunCodexOptions,
    | "instructionPath"
    | "serverUrl"
    | "userMemoryDbPath"
    | "workingDirectory"
    | "clientMcpServers"
  >,
) => buildCodexOptions(options).config;

export const startCodexAppServerThread = (
  rpc: CodexAppServerRpcClient,
  options: Pick<
    RunCodexOptions,
    | "instructionPath"
    | "serverUrl"
    | "userMemoryDbPath"
    | "workingDirectory"
    | "clientMcpServers"
    | "model"
    | "mode"
    | "effort"
  >,
) => {
  const threadOptions = buildCodexThreadOptions(options);
  return rpc.request("thread/start", {
    model: threadOptions.model,
    cwd: threadOptions.workingDirectory,
    approvalPolicy: threadOptions.approvalPolicy,
    sandbox: threadOptions.sandboxMode,
    config: appServerConfig(options),
  });
};

export const startCodexAppServerTurn = (
  rpc: CodexAppServerRpcClient,
  options: Pick<RunCodexOptions, "prompt" | "model" | "effort"> & {
    readonly threadId: string;
  },
) =>
  rpc.request("turn/start", {
    threadId: options.threadId,
    input: [
      {
        type: "text",
        text: options.prompt,
        text_elements: [],
      },
    ],
    model: options.model,
    effort: resolveCodexEffort(options.effort),
  });
