/**
 * Tests for scripts/ensure-binary.sh — focused on the hermetic dev-pin path.
 *
 * The download path needs gh/network and isn't unit-testable, but the dev pin
 * (~/.mimir/.cc-dev) is a pure local short-circuit: with the marker present the
 * script must exit 0 before any release check, so dev-install.sh's local build
 * is never clobbered by the wrapper's on-launch update.
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

const run = async () => {
  // Strip gh/curl reachability from PATH so a regression that falls through to
  // the network path fails the test loudly instead of hitting GitHub.
  const proc = Bun.spawn(["sh", scriptPath], {
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

test("dev pin (~/.mimir/.cc-dev) short-circuits the release check with exit 0", async () => {
  await writeFile(join(home, ".mimir", ".cc-dev"), "");

  const { exitCode, stderr } = await run();

  expect(exitCode).toBe(0);
  expect(stderr).toContain("dev build pinned");
});
