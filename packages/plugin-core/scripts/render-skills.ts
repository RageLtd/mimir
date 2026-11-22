#!/usr/bin/env bun
/**
 * Write each host's committed skill files from the shared sources in
 * plugin-core/src/skills. Run `bun run skills:render` from the repository
 * root after editing one — refactor.test.ts, testing.test.ts and
 * tickets.test.ts fail when a committed file drifts from this output.
 */

import { join } from "node:path";
import {
  REFACTOR_SKILL_FILES,
  renderRefactorSkill,
  type SkillHost,
} from "../src/skills/refactor";
import { TESTING_SKILL_ROOTS, TESTING_SKILLS } from "../src/skills/testing";
import { TICKET_SKILL_ROOTS, TICKET_SKILLS } from "../src/skills/tickets";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const HOSTS: readonly SkillHost[] = ["claudeCode", "opencode", "codex"];

for (const host of HOSTS) {
  const path = join(REPO_ROOT, REFACTOR_SKILL_FILES[host]);
  await Bun.write(path, renderRefactorSkill(host));
  console.log(`rendered ${path}`);
}

for (const root of TESTING_SKILL_ROOTS) {
  for (const [name, source] of Object.entries(TESTING_SKILLS)) {
    const path = join(REPO_ROOT, root, name, "SKILL.md");
    await Bun.write(path, source);
    console.log(`rendered ${path}`);
  }
}

for (const root of TICKET_SKILL_ROOTS) {
  for (const [name, source] of Object.entries(TICKET_SKILLS)) {
    const path = join(REPO_ROOT, root, name, "SKILL.md");
    await Bun.write(path, source);
    console.log(`rendered ${path}`);
  }
}
