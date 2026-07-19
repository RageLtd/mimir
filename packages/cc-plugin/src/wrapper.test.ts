/**
 * Integration test for the mimir wrapper script.
 *
 * Exercises the marker round-trip with a mock `claude` binary: launch
 * the wrapper, the mock writes its args+env to a log on each call, the
 * wrapper consumes ~/.mimir/next-session.json between invocations and
 * re-launches claude with the marker's env overrides + extra flags.
 *
 * The wrapper is bash so we spawn it through bash, with HOME and PATH
 * overridden to the temp environment. The template at
 * `artifacts/wrapper.sh.template` is the source of truth and is copied
 * into the temp dir verbatim for each test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const wrapperTemplate = await Bun.file(
  join(import.meta.dir, "..", "artifacts", "wrapper.sh.template"),
).text();

let tmp = "";
let wrapperPath = "";
let mockClaudeDir = "";
let logPath = "";
let markerPath = "";

const writeMockClaude = async (script: string) => {
  const path = join(mockClaudeDir, "claude");
  await writeFile(path, script);
  await chmod(path, 0o755);
};

const writeUpdater = async (script: string) => {
  const path = join(tmp, ".mimir", "ensure-binary.sh");
  await writeFile(path, script);
  await chmod(path, 0o755);
};

const runWrapper = async (args: string[] = []) => {
  const proc = Bun.spawn(["bash", wrapperPath, ...args], {
    env: {
      ...process.env,
      HOME: tmp,
      PATH: `${mockClaudeDir}:${process.env.PATH ?? ""}`,
      MIMIR_LOG: logPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return {
    exitCode: proc.exitCode ?? -1,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
};

const readLog = async () => {
  const raw = await readFile(logPath, "utf8");
  // Each invocation appends a record terminated by "---\n".
  return raw
    .split("---\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
};

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mimir-wrapper-"));
  await mkdir(join(tmp, ".mimir"), { recursive: true });

  // Touch the files BASE_ARGS reference so the wrapper has something
  // to point at even though the mock claude ignores them.
  await writeFile(join(tmp, ".mimir", "system-prompt.md"), "");
  await writeFile(join(tmp, ".mimir", "mcp.json"), "{}");
  await writeFile(join(tmp, ".mimir", "settings.json"), "{}");

  markerPath = join(tmp, ".mimir", "next-session.json");

  wrapperPath = join(tmp, "mimir");
  await writeFile(wrapperPath, wrapperTemplate);
  await chmod(wrapperPath, 0o755);

  mockClaudeDir = join(tmp, "bin");
  await mkdir(mockClaudeDir, { recursive: true });

  logPath = join(tmp, "claude.log");
});

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("mimir wrapper", () => {
  test("no marker — claude is invoked exactly once then loop exits", async () => {
    await writeMockClaude(`#!/usr/bin/env bash
echo "ANTHROPIC_BASE_URL=\${ANTHROPIC_BASE_URL:-unset}" >> "$MIMIR_LOG"
echo "args=$*" >> "$MIMIR_LOG"
echo "---" >> "$MIMIR_LOG"
exit 0
`);

    const result = await runWrapper();
    expect(result.exitCode).toBe(0);

    const records = await readLog();
    expect(records).toHaveLength(1);
    expect(records[0]).toContain("ANTHROPIC_BASE_URL=unset");
  });

  test("pre-staged marker triggers a second invocation with merged env + flags", async () => {
    await writeFile(
      markerPath,
      JSON.stringify({
        model: "glm-5.1",
        env: { ANTHROPIC_BASE_URL: "http://mimir-server:3000" },
        flags: ["--continue"],
      }),
    );

    await writeMockClaude(`#!/usr/bin/env bash
echo "ANTHROPIC_BASE_URL=\${ANTHROPIC_BASE_URL:-unset}" >> "$MIMIR_LOG"
echo "args=$*" >> "$MIMIR_LOG"
echo "---" >> "$MIMIR_LOG"
exit 0
`);

    const result = await runWrapper();
    expect(result.exitCode).toBe(0);

    const records = await readLog();
    expect(records).toHaveLength(2);

    // First call: pre-existing env (marker not consumed yet).
    expect(records[0]).toContain("ANTHROPIC_BASE_URL=unset");
    expect(records[0]).not.toContain("--model");
    expect(records[0]).not.toContain("--continue");

    // Second call: marker consumed, env + flags merged in.
    expect(records[1]).toContain("ANTHROPIC_BASE_URL=http://mimir-server:3000");
    expect(records[1]).toContain("--model glm-5.1");
    expect(records[1]).toContain("--continue");
  });

  test("marker is deleted after consumption", async () => {
    await writeFile(
      markerPath,
      JSON.stringify({ model: "glm-5.1", env: {}, flags: [] }),
    );

    await writeMockClaude(`#!/usr/bin/env bash
exit 0
`);

    await runWrapper();

    const stillExists = await Bun.file(markerPath).exists();
    expect(stillExists).toBe(false);
  });

  test("marker with only env (no model) still applies env on relaunch", async () => {
    await writeFile(
      markerPath,
      JSON.stringify({
        env: { CUSTOM_VAR: "value-from-marker" },
      }),
    );

    await writeMockClaude(`#!/usr/bin/env bash
echo "CUSTOM_VAR=\${CUSTOM_VAR:-unset}" >> "$MIMIR_LOG"
echo "args=$*" >> "$MIMIR_LOG"
echo "---" >> "$MIMIR_LOG"
exit 0
`);

    const result = await runWrapper();
    expect(result.exitCode).toBe(0);

    const records = await readLog();
    expect(records).toHaveLength(2);
    expect(records[0]).toContain("CUSTOM_VAR=unset");
    expect(records[1]).toContain("CUSTOM_VAR=value-from-marker");
    expect(records[1]).not.toContain("--model");
  });

  test("user-supplied args pass through on both invocations", async () => {
    await writeFile(
      markerPath,
      JSON.stringify({ model: "glm-5.1", env: {}, flags: [] }),
    );

    await writeMockClaude(`#!/usr/bin/env bash
echo "args=$*" >> "$MIMIR_LOG"
echo "---" >> "$MIMIR_LOG"
exit 0
`);

    await runWrapper(["--resume", "session-id"]);

    const records = await readLog();
    expect(records).toHaveLength(2);
    expect(records[0]).toContain("--resume session-id");
    expect(records[1]).toContain("--resume session-id");
    expect(records[1]).toContain("--model glm-5.1");
  });

  test("runs ensure-binary.sh before launch when present and executable", async () => {
    await writeUpdater(`#!/usr/bin/env bash
touch "$HOME/updater-ran"
exit 0
`);
    await writeMockClaude(`#!/usr/bin/env bash
echo "args=$*" >> "$MIMIR_LOG"
echo "---" >> "$MIMIR_LOG"
exit 0
`);

    const result = await runWrapper();
    expect(result.exitCode).toBe(0);

    // The updater ran...
    expect(await Bun.file(join(tmp, "updater-ran")).exists()).toBe(true);
    // ...and claude still launched exactly once.
    const records = await readLog();
    expect(records).toHaveLength(1);
  });

  test("a failing ensure-binary.sh warns but does not abort the launch", async () => {
    await writeUpdater(`#!/usr/bin/env bash
echo "boom" >&2
exit 1
`);
    await writeMockClaude(`#!/usr/bin/env bash
echo "args=$*" >> "$MIMIR_LOG"
echo "---" >> "$MIMIR_LOG"
exit 0
`);

    const result = await runWrapper();
    // set -e must not let the updater's non-zero exit kill the launch.
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("binary update check failed");

    const records = await readLog();
    expect(records).toHaveLength(1);
  });

  test("claude exit code does not abort the marker check", async () => {
    await writeFile(
      markerPath,
      JSON.stringify({ model: "glm-5.1", env: {}, flags: [] }),
    );

    // Mock returns non-zero on first call, zero on second.
    await writeMockClaude(`#!/usr/bin/env bash
COUNTER_FILE="$MIMIR_LOG.counter"
COUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
echo $((COUNT + 1)) > "$COUNTER_FILE"
echo "call=$COUNT args=$*" >> "$MIMIR_LOG"
echo "---" >> "$MIMIR_LOG"
if [[ "$COUNT" == "0" ]]; then
  exit 17
fi
exit 0
`);

    const result = await runWrapper();
    expect(result.exitCode).toBe(0);

    const records = await readLog();
    expect(records).toHaveLength(2);
    expect(records[0]).toContain("call=0");
    expect(records[1]).toContain("call=1");
    expect(records[1]).toContain("--model glm-5.1");
  });
});
