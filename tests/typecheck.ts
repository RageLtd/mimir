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
 *   bun run tests/typecheck.ts --require-mod-types
 *                                           # fail, not skip, the hooks-module
 *                                           # leg where its declarations are absent
 *
 * What a run does is decided in typecheck-plan.ts; this file runs it.
 */

import { resolve } from "node:path";
import {
  isPackage,
  MOD_TSCONFIG,
  MOD_TYPES_TSCONFIG,
  modLeg,
  packagesToRun,
  parseArgs,
} from "./typecheck-plan";

const ROOT = resolve(import.meta.dirname, "..");
const MOD_LEG = "cc-plugin hooks module";

const assertNever = (value: never) => {
  throw new Error(`Unhandled hooks-module leg: ${JSON.stringify(value)}`);
};

async function main() {
  const { filter, requireModTypes } = parseArgs(Bun.argv.slice(2));

  if (filter !== undefined && !isPackage(filter)) {
    console.log(`${filter} is not a package — typechecking all of them`);
  }

  const packages = packagesToRun(filter);

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

  // The cc-plugin hooks module types against declarations the Claude Code
  // engine lays into .claude-plugin/types/ on an interactive load of the
  // plugin — they are build-specific and gitignored, so the leg runs only
  // where they exist; absent, it skips, or fails under the flag.
  const leg = modLeg({
    filter,
    typesPresent: await Bun.file(resolve(ROOT, MOD_TYPES_TSCONFIG)).exists(),
    requireModTypes,
  });
  if (leg.kind !== "not-considered") {
    console.log(`\n── typecheck ${MOD_LEG} ──`);
  }
  switch (leg.kind) {
    case "not-considered":
      break;
    case "run": {
      const result = Bun.spawnSync(
        ["bunx", "tsc", "--noEmit", "-p", MOD_TSCONFIG],
        { cwd: ROOT, stdout: "inherit", stderr: "inherit" },
      );
      if (result.exitCode === 0) {
        passed++;
      } else {
        failures.push(MOD_LEG);
      }
      break;
    }
    case "skip":
      console.log(leg.note);
      break;
    case "fail":
      console.log(leg.message);
      failures.push(`${MOD_LEG} (not type-checked: declarations absent)`);
      break;
    default:
      assertNever(leg);
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
