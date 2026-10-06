import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

// Subprocess isolation keeps MIMIR_HOME and SQLite handles out of parallel tests.
test("default V2 entrypoint starts, registers hooks, and cleans up", async () => {
  const smoke = fileURLToPath(new URL("../scripts/smoke.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, smoke], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(`${stdout}\n${stderr}`).toContain("ALL V2 SMOKE CHECKS PASSED");
  expect(exitCode).toBe(0);
}, 30_000);
