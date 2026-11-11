/**
 * The session-end hand-off file — the whole conversation, passed from the
 * runner to its detached worker — and the command's entry gate. The file
 * lives under the Mimir home, readable by this user alone, and is gone once
 * the worker has read it; one a dead run left behind is swept by the next
 * write. (The preload points MIMIR_HOME at a scratch directory.)
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, stat, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mimirHome } from "@mimir/plugin-core/util";
import {
  HANDOFF_SWEEP_MS,
  readHandOff,
  writeHandOff,
} from "./session-end-hook";

const HANDOFF = {
  projectId: "project:abc",
  token: "owner-1",
  window: [{ role: "user" as const, content: "hello" }],
};
const SESSION_END = "session-end";
const OWNER_ONLY = 0o600;
const PERMISSION_BITS = 0o777;

const handOffDir = () => join(mimirHome(), SESSION_END);

describe("the hand-off file", () => {
  test("the sweep age is ten minutes", () => {
    expect(HANDOFF_SWEEP_MS).toBe(10 * 60_000);
  });

  test("is written under the Mimir home, not the system temp directory, readable by this user alone", async () => {
    const path = await writeHandOff(HANDOFF);
    expect(path.startsWith(`${handOffDir()}/`)).toBe(true);
    expect(path.startsWith(join(tmpdir(), "mimir-session-end-"))).toBe(false);
    expect((await stat(path)).mode & PERMISSION_BITS).toBe(OWNER_ONLY);
    await readHandOff(path);
  });

  test("reading it for the worker returns what was written and removes it", async () => {
    const path = await writeHandOff(HANDOFF);
    expect(await readHandOff(path)).toEqual(HANDOFF);
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("a hand-off older than the sweep age, left by a dead run, is removed by the next write; a fresh one stays", async () => {
    await mkdir(handOffDir(), { recursive: true });
    const stale = join(handOffDir(), "dead-run.json");
    const fresh = join(handOffDir(), "live-run.json");
    await Bun.write(stale, "{}");
    await Bun.write(fresh, "{}");
    const old = (Date.now() - HANDOFF_SWEEP_MS - 60_000) / 1000;
    await utimes(stale, old, old);

    const path = await writeHandOff(HANDOFF);

    expect(await Bun.file(stale).exists()).toBe(false);
    expect(await Bun.file(fresh).exists()).toBe(true);
    await readHandOff(path);
    await Bun.file(fresh).delete();
  });
});

describe("mimir-cc session-end, run as the hooks module runs it", () => {
  const run = async (stdin: string, env: Record<string, string>) => {
    const home = await mkdtemp(join(tmpdir(), "mimir-cc-session-end-"));
    const { MIMIR_ACTIVE: _active, ...rest } = process.env;
    const proc = Bun.spawn(
      ["bun", join(import.meta.dir, "cli.ts"), SESSION_END],
      {
        env: { ...rest, MIMIR_HOME: home, ...env },
        stdin: new Blob([stdin]),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const handOffs = await readdir(join(home, SESSION_END)).catch(() => []);
    return { exitCode, stdout, stderr, handOffs };
  };

  const PAYLOAD = JSON.stringify({
    session_id: "session-1",
    cwd: "/work/repo",
    reason: "prompt_input_exit",
    window: [
      { role: "user", content: [{ type: "text", text: "x".repeat(600) }] },
      { role: "assistant", content: [{ type: "text", text: "y".repeat(600) }] },
    ],
  });

  test("outside a Mimir session (MIMIR_ACTIVE unset) it exits 0 and hands nothing off", async () => {
    const ran = await run(PAYLOAD, {
      MIMIR_EXTRACTION_BASE_URL: "http://127.0.0.1:9/v1",
    });
    expect(ran).toEqual({ exitCode: 0, stdout: "", stderr: "", handOffs: [] });
  });

  for (const [what, stdin] of [
    ["empty stdin", ""],
    ["malformed JSON", "not json {"],
  ] as const) {
    test(`${what} exits 0 without throwing and hands nothing off`, async () => {
      const ran = await run(stdin, { MIMIR_ACTIVE: "1" });
      expect(ran).toEqual({
        exitCode: 0,
        stdout: "",
        stderr: "",
        handOffs: [],
      });
    });
  }
});
