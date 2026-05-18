/**
 * Codex app-server approval handler.
 *
 * The app-server sends JSON-RPC requests (with id) when it needs permission
 * to execute commands, apply file changes, or request elevated permissions.
 * We respond to each request using the existing RequestToolPermission
 * abstraction, or auto-approve when the approval policy is "never".
 */

import { toolTitle } from "../../agent/tool-reporting";
import { createChildLogger, log } from "../../utils/log";
import type { RequestToolPermission } from "../types";
import type { AppServerRequest } from "./app-server-rpc";

const logger = createChildLogger(log, "codex-approvals");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// ---------------------------------------------------------------------------
// Request param extraction
// ---------------------------------------------------------------------------

const commandFromParams = (params: Record<string, unknown>) => {
  if (typeof params.command === "string") return params.command;
  if (Array.isArray(params.command)) return params.command.join(" ");
  return "unknown command";
};

const reasonFromParams = (params: Record<string, unknown>) =>
  typeof params.reason === "string" ? params.reason : undefined;

const itemIdFromParams = (params: Record<string, unknown>) =>
  typeof params.itemId === "string"
    ? params.itemId
    : typeof params.callId === "string"
      ? params.callId
      : `approval:${Date.now()}`;

// ---------------------------------------------------------------------------
// Auto-approve responses
// ---------------------------------------------------------------------------

const AUTO_APPROVE_V2_COMMAND = { decision: "accept" };
const AUTO_APPROVE_V2_FILE = { decision: "accept" };
const AUTO_APPROVE_V2_PERMISSIONS = {
  permissions: {},
  scope: "session",
};
const AUTO_APPROVE_V1 = { decision: "approved" };

const autoApproveResponse = (method: string) => {
  if (method === "item/commandExecution/requestApproval")
    return AUTO_APPROVE_V2_COMMAND;
  if (method === "item/fileChange/requestApproval") return AUTO_APPROVE_V2_FILE;
  if (method === "item/permissions/requestApproval")
    return AUTO_APPROVE_V2_PERMISSIONS;
  if (method === "applyPatchApproval" || method === "execCommandApproval")
    return AUTO_APPROVE_V1;
  return null;
};

// ---------------------------------------------------------------------------
// Permission-bridged responses
// ---------------------------------------------------------------------------

const toolNameForMethod = (method: string) => {
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "execCommandApproval"
  )
    return "terminal";
  if (
    method === "item/fileChange/requestApproval" ||
    method === "applyPatchApproval"
  )
    return "codex_file_change";
  if (method === "item/permissions/requestApproval") return "permissions";
  return method;
};

const toolInputForMethod = (
  method: string,
  params: Record<string, unknown>,
) => {
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "execCommandApproval"
  ) {
    return { command: commandFromParams(params) };
  }
  if (method === "item/fileChange/requestApproval") {
    return {
      reason: reasonFromParams(params),
      ...(typeof params.grantRoot === "string"
        ? { grantRoot: params.grantRoot }
        : {}),
    };
  }
  if (method === "applyPatchApproval") {
    return {
      reason: reasonFromParams(params),
      ...(isRecord(params.fileChanges)
        ? { fileChanges: params.fileChanges }
        : {}),
    };
  }
  if (method === "item/permissions/requestApproval") {
    return {
      reason: reasonFromParams(params),
      ...(isRecord(params.permissions)
        ? { permissions: params.permissions }
        : {}),
    };
  }
  return {};
};

const bridgedDecision = (method: string, allowed: boolean) => {
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  ) {
    return allowed ? "accept" : "decline";
  }
  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    return allowed ? "approved" : "denied";
  }
  return allowed ? "accept" : "decline";
};

const bridgedResponse = (
  method: string,
  allowed: boolean,
  permanent: boolean,
) => {
  if (method === "item/permissions/requestApproval") {
    return {
      permissions: allowed ? {} : {},
      scope: permanent ? "session" : "turn",
    };
  }
  const decision = permanent
    ? method === "applyPatchApproval" || method === "execCommandApproval"
      ? "approved_for_session"
      : "acceptForSession"
    : bridgedDecision(method, allowed);
  return { decision };
};

// ---------------------------------------------------------------------------
// Unsupported request responses
// ---------------------------------------------------------------------------

const DECLINE_DYNAMIC_TOOL = { contentItems: [], success: false };
const DECLINE_USER_INPUT = { answers: {} };
const DECLINE_ELICITATION = { action: "decline" };

const unsupportedResponse = (method: string) => {
  if (method === "item/tool/call") return DECLINE_DYNAMIC_TOOL;
  if (method === "item/tool/requestUserInput") return DECLINE_USER_INPUT;
  if (method === "mcpServer/elicitation/request") return DECLINE_ELICITATION;
  return {};
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "applyPatchApproval",
  "execCommandApproval",
]);

const UNSUPPORTED_METHODS = new Set([
  "item/tool/call",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "account/chatgptAuthTokens/refresh",
]);

export type AppServerApprovalHandler = {
  readonly handleRequest: (request: AppServerRequest) => Promise<unknown>;
};

export const createAppServerApprovalHandler = (
  requestToolPermission: RequestToolPermission | undefined,
  autoApprove: boolean,
) => {
  const handleRequest = async (request: AppServerRequest) => {
    if (autoApprove) {
      const response = autoApproveResponse(request.method);
      if (response) return response;
    }

    if (APPROVAL_METHODS.has(request.method) && requestToolPermission) {
      const toolName = toolNameForMethod(request.method);
      const input = toolInputForMethod(request.method, request.params);
      const toolCallId = itemIdFromParams(request.params);
      const result = await requestToolPermission({
        toolName,
        input,
        toolCallId,
        title: toolTitle(toolName, input),
      });
      return bridgedResponse(
        request.method,
        result.allowed,
        result.permanent ?? false,
      );
    }

    if (APPROVAL_METHODS.has(request.method)) {
      // No permission callback — auto-approve as fallback
      const response = autoApproveResponse(request.method);
      if (response) return response;
    }

    if (UNSUPPORTED_METHODS.has(request.method)) {
      logger.debug("declining unsupported server request: %s", request.method);
      return unsupportedResponse(request.method);
    }

    logger.warn("unknown server request method: %s", request.method);
    return {};
  };

  return { handleRequest };
};
