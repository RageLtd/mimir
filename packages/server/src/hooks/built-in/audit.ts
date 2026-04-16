/**
 * Audit logger hook — logs all tool calls with timing for observability.
 */

import { log } from "../../util/logger";
import type { HookRegistry } from "../registry";

export function registerAuditHook(registry: HookRegistry): void {
  registry.onPostToolUse((ctx) => {
    log.info(
      {
        tool: ctx.toolName,
        type: ctx.toolType,
        durationMs: ctx.durationMs,
        project: ctx.project,
      },
      "tool_call_audit",
    );
    return undefined;
  });
}
