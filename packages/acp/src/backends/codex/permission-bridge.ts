/**
 * Codex PermissionRequest hook bridge.
 *
 * The Codex SDK does not expose approval requests as stream events. Codex
 * does expose synchronous PermissionRequest hooks, so we install a per-session
 * hook command that forwards the hook payload over a local socket to Mimir.
 * Mimir can then ask the ACP client to render its normal permission UI.
 */

import { mkdir, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import type { CodexOptions } from "@openai/codex-sdk";
import { toolTitle } from "../../agent/tool-reporting";
import type { SessionState } from "../../agent/types";
import { createRequestToolPermission } from "../../permissions";
import { createChildLogger, log } from "../../utils/log";
import type { RequestToolPermission, ToolPermissionResult } from "../types";

const logger = createChildLogger(log, "codex-permission-bridge");

const bridgeDir = () => "/tmp/mimir-codex-permissions";
const bridgeScriptPath = () => `${bridgeDir()}/permission-hook.js`;
const socketPathForSession = (sessionId: string) =>
  `${bridgeDir()}/${sessionId}.sock`;

const hookScript = () => `#!/usr/bin/env node
const net = require("node:net");

const socketPath = process.argv[2];

const deny = (message) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message },
    },
  }));
};

if (!socketPath) {
  deny("Mimir permission bridge socket was not provided.");
  process.exit(0);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const client = net.createConnection(socketPath);
  let output = "";
  client.setEncoding("utf8");
  client.on("connect", () => {
    client.end(input);
  });
  client.on("data", (chunk) => {
    output += chunk;
  });
  client.on("end", () => {
    process.stdout.write(output);
  });
  client.on("error", (error) => {
    deny(\`Mimir permission bridge failed: \${error.message}\`);
  });
});
`;

export type CodexPermissionBridge = {
  readonly socketPath: string;
  readonly command: string;
  readonly close: () => Promise<void>;
};

type HookInput = {
  readonly turn_id?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseHookInput = (raw: string): HookInput => {
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed)) return {};
  return {
    turn_id: typeof parsed.turn_id === "string" ? parsed.turn_id : undefined,
    tool_name:
      typeof parsed.tool_name === "string" ? parsed.tool_name : undefined,
    tool_input: parsed.tool_input,
  };
};

const hookResponseForPermission = (permission: ToolPermissionResult) => {
  if (permission.allowed) {
    return {
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: {
        behavior: "deny",
        message: permission.message ?? "Permission denied by user",
      },
    },
  };
};

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

const readSocketPayload = (socket: NodeJS.ReadWriteStream) =>
  new Promise<string>((resolve, reject) => {
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      raw += chunk;
    });
    socket.on("end", () => resolve(raw));
    socket.on("error", reject);
  });

const handleHookPayload = async (
  raw: string,
  requestToolPermission: RequestToolPermission,
) => {
  const input = parseHookInput(raw);
  const toolName = input.tool_name ?? "Codex";
  const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
  const toolCallId =
    typeof input.turn_id === "string" && input.turn_id.length > 0
      ? `${input.turn_id}:${toolName}`
      : `${toolName}:${Date.now()}`;

  const permission = await requestToolPermission({
    toolName,
    input: toolInput,
    toolCallId,
    title: toolTitle(toolName, toolInput),
  });
  return hookResponseForPermission(permission);
};

const startSocketServer = (
  socketPath: string,
  requestToolPermission: RequestToolPermission,
) =>
  new Promise<Server>((resolve, reject) => {
    const server = createServer((socket) => {
      readSocketPayload(socket)
        .then((payload) => handleHookPayload(payload, requestToolPermission))
        .then((response) => socket.end(JSON.stringify(response)))
        .catch((err) => {
          logger.warn("permission bridge request failed:", err);
          socket.end(
            JSON.stringify(
              hookResponseForPermission({
                allowed: false,
                message: "Permission bridge failed",
              }),
            ),
          );
        });
    });

    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve(server);
    });
  });

export const startCodexPermissionBridge = async (
  session: SessionState,
  conn: Parameters<typeof createRequestToolPermission>[0],
) => {
  await mkdir(bridgeDir(), { recursive: true });
  const scriptPath = bridgeScriptPath();
  await Bun.write(scriptPath, hookScript());

  const socketPath = socketPathForSession(session.sessionId);
  await unlink(socketPath).catch(() => undefined);

  const requestToolPermission = createRequestToolPermission(
    conn,
    session.sessionId,
  );
  const cachedRequestToolPermission: RequestToolPermission = async (
    request,
  ) => {
    if (session.permanentlyAllowedTools.has(request.toolName)) {
      return { allowed: true, permanent: true };
    }
    const result = await requestToolPermission(request);
    if (result.allowed && result.permanent) {
      session.permanentlyAllowedTools.add(request.toolName);
    }
    return result;
  };

  const server = await startSocketServer(
    socketPath,
    cachedRequestToolPermission,
  );
  const command = `${shellQuote(process.execPath)} ${shellQuote(scriptPath)} ${shellQuote(socketPath)}`;

  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => undefined);
  };

  return { socketPath, command, close } satisfies CodexPermissionBridge;
};

export const buildCodexPermissionHookConfig = (
  bridge: CodexPermissionBridge | null,
) => {
  const config: NonNullable<CodexOptions["config"]> = {};
  if (!bridge) return config;
  config.features = { hooks: true };
  config.hooks = {
    PermissionRequest: [
      {
        matcher: "*",
        hooks: [
          {
            type: "command",
            command: bridge.command,
            timeout: 300,
            statusMessage: "Waiting for editor approval",
          },
        ],
      },
    ],
  };
  return config;
};
