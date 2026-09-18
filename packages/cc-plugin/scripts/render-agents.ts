#!/usr/bin/env bun
/**
 * Render the plugin's worker agents into `agents/` from the server's
 * system-prompt seed. Run `bun run agents:render` after editing
 * packages/server/system-prompt.md or plugin-core/src/workers —
 * agents.test.ts fails when the committed files drift from this output.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AGENTS_DIR, renderSeedAgents } from "../src/agents";

await mkdir(AGENTS_DIR, { recursive: true });
for (const agent of await renderSeedAgents()) {
  const path = join(AGENTS_DIR, agent.file);
  await Bun.write(path, agent.content);
  console.log(`rendered ${path}`);
}
