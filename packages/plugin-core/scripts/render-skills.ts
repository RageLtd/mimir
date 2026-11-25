#!/usr/bin/env bun
/**
 * Write each host's committed skill files from the shared sources in
 * plugin-core/src/skills. Run `bun run skills:render` from the repository
 * root after editing one — shared.test.ts fails when a committed file
 * drifts from this output.
 */

import { join } from "node:path";
import { SHARED_SKILL_ROOTS, SHARED_SKILLS } from "../src/skills/shared";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

for (const root of SHARED_SKILL_ROOTS) {
  for (const [name, source] of Object.entries(SHARED_SKILLS)) {
    const path = join(REPO_ROOT, root, name, "SKILL.md");
    await Bun.write(path, source);
    console.log(`rendered ${path}`);
  }
}
