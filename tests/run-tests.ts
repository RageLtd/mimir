#!/usr/bin/env bun
/**
 * Test runner that runs each test file in isolation to avoid Bun's mock.module pollution.
 *
 * Usage:
 *   bun run tests/run-tests.ts              # all packages
 *   bun run tests/run-tests.ts server       # only @mimir/server
 *   bun run tests/run-tests.ts acp          # only @mimir/acp
 */

import { resolve } from "node:path";
import { Glob } from "bun";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES = ["server", "acp", "cc-plugin", "plugin-core", "oc-plugin"];

function discoverTests(pkg: string) {
  const pkgDir = resolve(ROOT, "packages", pkg);
  const glob = new Glob("src/**/*.test.ts");
  const files = [...glob.scanSync(pkgDir)];
  return files.map((f) => ({ pkg, pkgDir, file: f }));
}

async function main() {
  const filter = Bun.argv[2];

  if (filter && !PACKAGES.includes(filter)) {
    console.error(`Unknown package: ${filter}`);
    console.error(`Available: ${PACKAGES.join(", ")}`);
    process.exit(1);
  }

  const packages = filter ? [filter] : PACKAGES;
  const tests = packages.flatMap(discoverTests);

  if (tests.length === 0) {
    console.log("No test files found.");
    process.exit(0);
  }

  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (const { pkg, pkgDir, file } of tests) {
    const result = Bun.spawnSync(["bun", "test", file], {
      cwd: pkgDir,
      stdout: "inherit",
      stderr: "inherit",
    });

    if (result.exitCode === 0) {
      passed++;
    } else {
      failed++;
      failures.push(`${pkg}/${file}`);
    }
  }

  console.log(`\n${passed + failed} files, ${passed} passed, ${failed} failed`);

  if (failures.length > 0) {
    console.log("\nFailed:");
    for (const f of failures) {
      console.log(`  ${f}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
