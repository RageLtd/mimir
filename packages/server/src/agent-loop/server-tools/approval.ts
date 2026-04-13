/**
 * Approval server tool — records developer approval for destructive actions.
 *
 * When the destructive action guard blocks a tool call, the model asks the
 * developer for permission. Once the developer approves, the model calls
 * this tool to record the approval. The destructive guard then allows
 * the next attempt through.
 *
 * This is a server tool (has execute) — it runs inside the agent loop
 * and its result feeds back to the model.
 */

import { tool } from "ai";
import { z } from "zod";
import { approvalKey, getApprovalTracker } from "../../hooks/approval";
import { clearDenials } from "../../hooks/built-in/destructive";
import { log } from "../../util/logger";
import { CACHE_CONTROL } from "./shared";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ApproveActionSchema = z.object({
  tool_name: z.string().describe("The tool that was blocked (e.g. 'bash')"),
  command: z
    .string()
    .describe("The exact command that was blocked and needs approval"),
});

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

const executeApproveAction = async ({
  tool_name,
  command,
}: z.infer<typeof ApproveActionSchema>) => {
  // We need the fingerprint from the hook context, but server tools
  // don't receive it directly. The approval tracker uses global scope
  // as fallback, and the destructive guard passes fingerprint when
  // checking. We extract fingerprint from the wrapping hook context.
  //
  // Workaround: approve globally. The approval key is specific enough
  // (tool:command) that cross-conversation collisions are unlikely,
  // and approvals are in-memory (cleared on restart).
  const key = approvalKey(tool_name, { command });
  const tracker = getApprovalTracker();
  tracker.approve(key, null); // null = global scope

  // Also clear denial counters so the retry isn't escalated
  clearDenials(null);

  log.info({ tool_name, command, key }, "approve_action");

  return {
    approved: true,
    key,
    message: `Action approved. You may now retry the command: ${command}`,
  };
};

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const approvalTools = {
  approve_action: tool({
    description: [
      "Record developer approval for a previously blocked destructive action.",
      "Call this AFTER the developer has explicitly approved a destructive command.",
      "Then retry the original command — the guard will allow it through.",
    ].join(" "),
    inputSchema: ApproveActionSchema,
    providerOptions: CACHE_CONTROL,
    execute: executeApproveAction,
  }),
};
