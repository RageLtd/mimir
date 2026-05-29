/**
 * Backend-agnostic tool permission bridge.
 *
 * `createRequestToolPermission` returns a `RequestToolPermission` callback
 * that forwards permission prompts to the ACP client (Zed) via
 * `conn.requestPermission()`. The callback is created once per session and
 * threaded through `BackendRunOptions` so the server backend can call it
 * directly before executing each tool.
 */

import type {
  AgentSideConnection,
  PermissionOption,
} from "@agentclientprotocol/sdk";
import type {
  ToolPermissionRequest,
  ToolPermissionResult,
} from "./backends/types";
import { createChildLogger, log } from "./utils/log";

const logger = createChildLogger(log, "permissions");

const ALLOW_ONCE_ID = "allow_once";
const ALLOW_ALWAYS_ID = "allow_always";
const REJECT_ONCE_ID = "reject_once";

const PERMISSION_OPTIONS: PermissionOption[] = [
  { optionId: ALLOW_ONCE_ID, name: "Allow", kind: "allow_once" },
  { optionId: ALLOW_ALWAYS_ID, name: "Always Allow", kind: "allow_always" },
  { optionId: REJECT_ONCE_ID, name: "Deny", kind: "reject_once" },
];

/**
 * Create a `RequestToolPermission` callback that bridges to ACP's
 * `requestPermission` protocol method. Zed renders the permission dialog;
 * the user's choice is mapped to a `ToolPermissionResult`.
 */
export const createRequestToolPermission = (
  conn: AgentSideConnection,
  sessionId: string,
) => {
  const requestPermission = async (request: ToolPermissionRequest) => {
    logger.info(
      { toolName: request.toolName, toolCallId: request.toolCallId },
      "requesting tool permission from client",
    );

    const response = await conn.requestPermission({
      sessionId,
      toolCall: {
        toolCallId: request.toolCallId,
        title: request.title ?? request.toolName,
        rawInput: request.input,
        kind: "execute",
      },
      options: PERMISSION_OPTIONS,
    });

    const outcome = response.outcome;

    if (outcome.outcome === "cancelled") {
      logger.info(
        { toolName: request.toolName },
        "permission request cancelled",
      );
      return { allowed: false, message: "Permission request cancelled" };
    }

    const optionId = outcome.optionId;

    if (optionId === ALLOW_ALWAYS_ID) {
      logger.info(
        { toolName: request.toolName },
        "permission granted (always)",
      );
      return { allowed: true, permanent: true } satisfies ToolPermissionResult;
    }

    if (optionId === ALLOW_ONCE_ID) {
      logger.info({ toolName: request.toolName }, "permission granted (once)");
      return { allowed: true, permanent: false } satisfies ToolPermissionResult;
    }

    // reject_once or any unknown option → deny
    logger.info(
      { toolName: request.toolName, optionId },
      "permission denied by user",
    );
    return {
      allowed: false,
      message: "Permission denied by user",
    } satisfies ToolPermissionResult;
  };

  return requestPermission;
};
