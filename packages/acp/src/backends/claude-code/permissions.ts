/**
 * CC SDK permission adapter.
 *
 * Wraps the generic `RequestToolPermission` callback into the CC SDK's
 * `CanUseTool` shape so it can be passed directly into SDK `Options`.
 * The generic callback handles ACP transport; this module handles the
 * SDK-specific type mapping.
 */

import type {
  CanUseTool,
  PermissionUpdate,
} from "@anthropic-ai/claude-agent-sdk";
import type { RequestToolPermission } from "../types";

/**
 * Adapt a generic `RequestToolPermission` into the CC SDK's `CanUseTool`
 * callback. Set once at Query creation and reused for the session lifetime.
 */
export const toCanUseTool = (requestToolPermission: RequestToolPermission) => {
  const canUseTool: CanUseTool = async (toolName, input, options) => {
    const result = await requestToolPermission({
      toolName,
      input,
      toolCallId: options.toolUseID,
      title: options.title ?? options.displayName,
      description: options.description,
    });

    if (!result.allowed) {
      return {
        behavior: "deny" as const,
        message: result.message ?? "Permission denied",
        toolUseID: options.toolUseID,
        decisionClassification: "user_reject" as const,
      };
    }

    if (result.permanent && options.suggestions) {
      return {
        behavior: "allow" as const,
        updatedInput: input,
        updatedPermissions: options.suggestions as PermissionUpdate[],
        toolUseID: options.toolUseID,
        decisionClassification: "user_permanent" as const,
      };
    }

    return {
      behavior: "allow" as const,
      updatedInput: input,
      toolUseID: options.toolUseID,
      decisionClassification: "user_temporary" as const,
    };
  };

  return canUseTool;
};
