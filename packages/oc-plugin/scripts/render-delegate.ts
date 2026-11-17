#!/usr/bin/env bun
/**
 * Render `commands/delegate.md` from the shared coordinator prompt in
 * plugin-core/src/workers. Run `bun run delegate:render` after editing
 * delegate-policy.ts or delegate-opencode.ts — delegate-md.test.ts
 * fails when the committed file drifts from this output.
 */

import { join } from "node:path";
import { renderDelegateCommand } from "@mimir/plugin-core/workers";

const path = join(import.meta.dir, "..", "commands", "delegate.md");
await Bun.write(path, renderDelegateCommand("opencode"));
console.log(`rendered ${path}`);
