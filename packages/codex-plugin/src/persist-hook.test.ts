/**
 * Persist hook, run as Codex runs it: the CLI with the Stop payload on
 * stdin. The captured rollout holds one real user turn, so extraction's
 * two-user-turn gate skips it before any endpoint is contacted.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "cli.ts");
const FIXTURE = join(
  import.meta.dir,
  "..",
  "test-fixtures",
  "rollout-basic-session.jsonl",
);
const SESSION = "persist-hook-test";

let sandbox: string;

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), "mimir-codex-persist-test-"));
});

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const runPersist = async (env: Record<string, string>) => {
  const proc = Bun.spawn(["bun", CLI, "persist"], {
    stdin: new Blob([
      JSON.stringify({
        session_id: SESSION,
        transcript_path: FIXTURE,
        cwd: sandbox,
      }),
    ]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MIMIR_ACTIVE: "1", MIMIR_HOME: sandbox, ...env },
  });
  return proc.exited;
};

const watermark = () =>
  Bun.file(join(sandbox, "persist-state", `${SESSION}.json`));

describe("persist hook watermark", () => {
  test("a gate skip keeps the watermark, so the next turn carries this one with it", async () => {
    const exitCode = await runPersist({
      // Never contacted: the gate skips first.
      MIMIR_EXTRACTION_BASE_URL: "http://127.0.0.1:9",
      MIMIR_EXTRACTION_MODEL: "test",
    });
    expect(exitCode).toBe(0);
    expect(await watermark().exists()).toBe(false);
  });

  test("with no endpoint configured the watermark advances past the turn", async () => {
    const exitCode = await runPersist({
      MIMIR_EXTRACTION_BASE_URL: "",
      MIMIR_EXTRACTION_MODEL: "",
      MIMIR_SMALL_MODEL: "",
    });
    expect(exitCode).toBe(0);
    expect(await watermark().json()).toEqual({ offset: 27 });
  });

  test("a watermark write that throws does not fail the hook", async () => {
    // A regular file where the state directory belongs: mkdir rejects.
    const home = mkdtempSync(join(tmpdir(), "mimir-codex-persist-unwritable-"));
    writeFileSync(join(home, "persist-state"), "not a directory");
    try {
      const exitCode = await runPersist({
        MIMIR_HOME: home,
        MIMIR_EXTRACTION_BASE_URL: "",
        MIMIR_EXTRACTION_MODEL: "",
        MIMIR_SMALL_MODEL: "",
      });
      expect(exitCode).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
