/**
 * Middleware 2.6: Project Rules Injection
 *
 * Reads `metadata.project_rules` from the request — the formatted project
 * rules string built client-side by mimir-acp from `.claude/rules/`, CLAUDE.md,
 * and AGENTS.md. Stored on `ctx.projectRules` so MW3 includes them in the
 * context injection as a dedicated `<project_rules>` section.
 *
 * Runs after MW2.5 (User Profile) and before MW3 (Context Assembly).
 */

import { log } from "../util/logger";
import type { MimirContext } from "./types";

export function injectProjectRules(ctx: MimirContext) {
  const rules = ctx.request.metadata?.project_rules as string | undefined;
  if (!rules) {
    log.debug("no project_rules in metadata, skipping injection");
    return;
  }

  ctx.projectRules = rules;
  log.info({ blockLength: rules.length }, "project rules injected");
}
