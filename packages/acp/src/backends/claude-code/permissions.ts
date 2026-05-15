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
import { toolTitle } from "../../agent/tool-reporting";
import type { RequestToolPermission } from "../types";

/**
 * Adapt a generic `RequestToolPermission` into the CC SDK's `CanUseTool`
 * callback. Set once at Query creation and reused for the session lifetime.
 */
export const toCanUseTool = (requestToolPermission: RequestToolPermission) => {
  const canUseTool: CanUseTool = async (toolName, input, options) => {
    // The SDK's options.title / options.displayName are bridge-level labels
    // (e.g. "Bash", "Read file") — not the specific command or path. Fall
    // back to toolTitle() which extracts the actual command/path from input.
    const title =
      options.title ?? toolTitle(toolName, input as Record<string, unknown>);

    const result = await requestToolPermission({
      toolName,
      input,
      toolCallId: options.toolUseID,
      title,
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
