#!/usr/bin/env bun
/**
 * Render each host's committed refactor skill from the shared source in
 * plugin-core/src/skills/refactor.ts. Run `bun run skills:render` from the
 * repository root after editing it — refactor.test.ts fails when a
 * committed file drifts from this output.
 */

import { join } from "node:path";
import {
  REFACTOR_SKILL_FILES,
  renderRefactorSkill,
  type SkillHost,
} from "../src/skills/refactor";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const HOSTS: readonly SkillHost[] = ["claudeCode", "opencode", "codex"];

for (const host of HOSTS) {
  const path = join(REPO_ROOT, REFACTOR_SKILL_FILES[host]);
  await Bun.write(path, renderRefactorSkill(host));
  console.log(`rendered ${path}`);
}
