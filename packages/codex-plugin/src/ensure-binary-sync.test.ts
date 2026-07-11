/**
 * Drift guard: scripts/ensure-binary.sh must stay byte-identical to the
 * canonical copy in plugin-core. The mirror exists because the codex
 * marketplace bootstrap skill runs the script from the plugin root, which
 * must be self-contained.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";

const canonical = join(
  import.meta.dir,
  "../../plugin-core/scripts/ensure-binary.sh",
);
const mirror = join(import.meta.dir, "../scripts/ensure-binary.sh");

test("scripts/ensure-binary.sh mirrors the plugin-core canonical byte-for-byte", async () => {
  const [canonicalText, mirrorText] = await Promise.all([
    Bun.file(canonical).text(),
    Bun.file(mirror).text(),
  ]);

  // Canonical lives at packages/plugin-core/scripts/ensure-binary.sh — edit
  // there, then: cp packages/plugin-core/scripts/ensure-binary.sh packages/codex-plugin/scripts/
  expect(mirrorText).toBe(canonicalText);
});
