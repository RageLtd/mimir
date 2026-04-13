#!/usr/bin/env bun
/**
 * Test runner that runs each test file in isolation to avoid Bun's mock pollution bug.
 */

import { Glob } from "bun";

async function main() {
  const glob = new Glob("src/**/*.test.ts");
  const testFiles = [...glob.scanSync(".")];

  let passed = 0;
  let failed = 0;

  for (const file of testFiles) {
    const result = Bun.spawnSync(["bun", "test", file], {
      stdout: "inherit",
      stderr: "inherit",
    });

    if (result.exitCode === 0) {
      passed++;
    } else {
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
