/**
 * Tests for scripts/ensure-binary.sh — focused on the hermetic paths:
 * flavor selection and the dev-pin short-circuit.
 *
 * The download path needs gh/network and isn't unit-testable, but the dev pin
 * (~/.mimir/.cc-dev / ~/.mimir/.codex-dev) is a pure local short-circuit: with
 * the marker present the script must exit 0 before any release check, so a
 * dev-install.sh local build is never clobbered by the wrapper's on-launch
 * update.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(import.meta.dir, "..", "scripts", "ensure-binary.sh");

let home = "";

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mimir-ensure-"));
  await mkdir(join(home, ".mimir"), { recursive: true });
});

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

const run = async (...args: string[]) => {
  // Strip gh/curl reachability from PATH so a regression that falls through to
  // the network path fails the test loudly instead of hitting GitHub.
  const proc = Bun.spawn(["sh", scriptPath, ...args], {
    env: { HOME: home, PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return {
    exitCode: proc.exitCode ?? -1,
    stderr: await new Response(proc.stderr).text(),
  };
};

const pin = (name: string) => writeFile(join(home, ".mimir", name), "");

test("no arg defaults to cc: ~/.mimir/.cc-dev short-circuits with exit 0", async () => {
  await pin(".cc-dev");

  const { exitCode, stderr } = await run();

  expect(exitCode).toBe(0);
  expect(stderr).toContain("dev build pinned");
});

test("explicit cc flavor honors ~/.mimir/.cc-dev", async () => {
  await pin(".cc-dev");

  const { exitCode, stderr } = await run("cc");

  expect(exitCode).toBe(0);
  expect(stderr).toContain("dev build pinned");
});

test("codex flavor honors ~/.mimir/.codex-dev", async () => {
  await pin(".codex-dev");

  const { exitCode, stderr } = await run("codex");

  expect(exitCode).toBe(0);
  expect(stderr).toContain("dev build pinned");
});

test("codex flavor ignores the cc dev pin and proceeds to the release check", async () => {
  await pin(".cc-dev");

  const { exitCode, stderr } = await run("codex");

  // No gh/curl on the stripped PATH and no binary installed under this HOME,
  // so proceeding past the pin correctly ends in the loud unreachable error.
  expect(exitCode).toBe(1);
  expect(stderr).not.toContain("dev build pinned");
  expect(stderr).toContain("Cannot reach");
});

test("unknown flavor exits 1 with a loud error", async () => {
  const { exitCode, stderr } = await run("opencode");

  expect(exitCode).toBe(1);
  expect(stderr).toContain("Unknown flavor: opencode");
});
