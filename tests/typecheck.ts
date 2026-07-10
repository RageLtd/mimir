#!/usr/bin/env bun
/**
 * Typecheck runner — runs `tsc --noEmit` against each package's tsconfig.
 *
 * The release build (`bun build --minify`) transpiles WITHOUT type-checking,
 * and the test harness doesn't typecheck either, so type errors could ship a
 * green bundle. This gate closes that gap: CI runs it alongside the tests.
 *
 * Usage:
 *   bun run tests/typecheck.ts              # all packages
 *   bun run tests/typecheck.ts server       # only @mimir/server
 */

import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGES = [
  "server",
  "plugin-core",
  "acp",
  "cc-plugin",
  "oc-plugin",
  "codex-plugin",
];

async function main() {
  const filter = Bun.argv[2];

  if (filter && !PACKAGES.includes(filter)) {
    console.error(`Unknown package: ${filter}`);
    console.error(`Available: ${PACKAGES.join(", ")}`);
    process.exit(1);
  }

  const packages = filter ? [filter] : PACKAGES;

  let passed = 0;
  const failures: string[] = [];

  for (const pkg of packages) {
    console.log(`\n── typecheck ${pkg} ──`);
    const result = Bun.spawnSync(
      ["bunx", "tsc", "--noEmit", "-p", `packages/${pkg}/tsconfig.json`],
      { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
    );
    if (result.exitCode === 0) {
      passed++;
    } else {
      failures.push(pkg);
    }
  }

  console.log(
    `\n${packages.length} packages, ${passed} clean, ${failures.length} with errors`,
  );

  if (failures.length > 0) {
    console.log(`\nType errors in: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
