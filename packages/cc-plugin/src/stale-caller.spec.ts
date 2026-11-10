/**
 * A plugin older than this binary still calls it the old way: the binary
 * updates on every wrapper launch, the plugin when the developer updates
 * it. Those calls must not fail a hook on every prompt and Bash call.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { staleCaller } from "./stale-caller";

describe("staleCaller", () => {
  test("edit-guard, a command the hooks module took over, is a stale call kept quiet", () => {
    expect(staleCaller("edit-guard", [])).toEqual({
      command: "edit-guard",
      isShown: false,
    });
  });

  test("voice-anchor without its arguments is a stale call the developer is shown", () => {
    expect(staleCaller("voice-anchor", [])).toEqual({
      command: "voice-anchor",
      isShown: true,
    });
  });

  test("voice-anchor as the hooks module calls it is current", () => {
    expect(
      staleCaller("voice-anchor", ["--session", "s", "--nth", "0"]),
    ).toBeNull();
  });

  test("any other command is current", () => {
    expect(staleCaller("persist", [])).toBeNull();
    expect(staleCaller(undefined, [])).toBeNull();
  });
});

describe("mimir-cc called by a stale plugin", () => {
  const run = async (...argv: string[]) => {
    const home = await mkdtemp(join(tmpdir(), "mimir-stale-"));
    const proc = Bun.spawn(["bun", join(import.meta.dir, "cli.ts"), ...argv], {
      env: { ...process.env, MIMIR_ACTIVE: "1", MIMIR_HOME: home },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  };

  test("edit-guard exits clean and silent", async () => {
    expect(await run("edit-guard")).toEqual({
      exitCode: 0,
      stdout: "",
      stderr: "",
    });
  });

  test("bare voice-anchor exits clean and tells the developer to update the plugin", async () => {
    const ran = await run("voice-anchor");
    expect(ran.exitCode).toBe(0);
    expect(ran.stderr).toBe("");
    const out: unknown = JSON.parse(ran.stdout);
    expect(out).toEqual({
      systemMessage: expect.stringContaining("update the mimir-cc plugin"),
    });
  });
});
