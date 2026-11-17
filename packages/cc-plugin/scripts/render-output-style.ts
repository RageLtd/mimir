#!/usr/bin/env bun
/**
 * Render the plugin's forced output style into `output-styles/mimir.md`
 * from the server's system-prompt seed. Run `bun run output-style:render`
 * after editing packages/server/system-prompt.md — output-style.spec.ts
 * fails when the committed file drifts from this output.
 */

import { OUTPUT_STYLE_FILE, renderSeedOutputStyle } from "../src/output-style";

await Bun.write(OUTPUT_STYLE_FILE, await renderSeedOutputStyle());
console.log(`rendered ${OUTPUT_STYLE_FILE}`);
