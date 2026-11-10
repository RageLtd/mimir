/**
 * Integration test for the mimir wrapper script.
 *
 * Launches the wrapper against a mock `claude` (and a mock `mimir-cc`)
 * that log their args + env, with HOME and PATH pointed at a temp
 * environment. The template at `artifacts/wrapper.sh.template` is the
 * source of truth and is copied into the temp dir verbatim for each test.
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

const LOGGING_CLAUDE = `#!/usr/bin/env bash
echo "args=$*" >> "$MIMIR_LOG"
echo "---" >> "$MIMIR_LOG"
exit 0
`;

let tmp = "";
let wrapperPath = "";
let mockClaudeDir = "";
let logPath = "";

const writeExecutable = async (path: string, script: string) => {
  await writeFile(path, script);
  await chmod(path, 0o755);
};

const writeMockClaude = (script: string) =>
  writeExecutable(join(mockClaudeDir, "claude"), script);

const writeMockBinary = (script: string) =>
  writeExecutable(join(tmp, ".local", "bin", "mimir-cc"), script);

const writeUpdater = (script: string) =>
  writeExecutable(join(tmp, ".mimir", "ensure-binary.sh"), script);

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
  await mkdir(join(tmp, ".local", "bin"), { recursive: true });
  await writeFile(join(tmp, ".mimir", "settings.json"), "{}");

  wrapperPath = join(tmp, "mimir");
  await writeExecutable(wrapperPath, wrapperTemplate);

  mockClaudeDir = join(tmp, "bin");
  await mkdir(mockClaudeDir, { recursive: true });

  logPath = join(tmp, "claude.log");
});

afterEach(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("mimir wrapper", () => {
  test("launches claude once with --settings and no system-prompt flag", async () => {
    await writeMockClaude(`#!/usr/bin/env bash
echo "MIMIR_ACTIVE=\${MIMIR_ACTIVE:-unset}" >> "$MIMIR_LOG"
echo "args=$*" >> "$MIMIR_LOG"
echo "---" >> "$MIMIR_LOG"
exit 0
`);

    const result = await runWrapper();
    expect(result.exitCode).toBe(0);

    const records = await readLog();
    expect(records).toHaveLength(1);
    expect(records[0]).toContain("MIMIR_ACTIVE=1");
    expect(records[0]).toContain(
      `--settings ${join(tmp, ".mimir", "settings.json")}`,
    );
    expect(records[0]).not.toContain("--system-prompt-file");
  });

  test("user-supplied args pass through after the wrapper's own", async () => {
    await writeMockClaude(LOGGING_CLAUDE);

    await runWrapper(["--resume", "session-id"]);

    const records = await readLog();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatch(/--settings \S+ --resume session-id$/);
  });

  test("claude's exit code is the wrapper's exit code", async () => {
    await writeMockClaude(`#!/usr/bin/env bash
exit 17
`);

    const result = await runWrapper();
    expect(result.exitCode).toBe(17);
  });

  test("survives being rewritten while a launch is in flight", async () => {
    // The mock claude overwrites the wrapper mid-run with a different,
    // shorter script — what `mimir-cc update` does from inside a session.
    // A wrapper still resident in bash would resume at a stale offset.
    await writeMockClaude(`#!/usr/bin/env bash
echo "args=$*" >> "$MIMIR_LOG"
echo "---" >> "$MIMIR_LOG"
printf '#!/usr/bin/env bash\\necho replaced >> "$MIMIR_LOG"\\n' > "${wrapperPath}"
exit 0
`);

    const result = await runWrapper();
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("syntax error");
    const records = await readLog();
    expect(records).toHaveLength(1);
    expect(records[0]).not.toContain("replaced");
  });

  test("leaves an installed binary alone: the plugin's hooks module keeps it at the plugin's version", async () => {
    await writeUpdater(`#!/usr/bin/env bash
touch "$HOME/updater-ran"
exit 0
`);
    await writeMockBinary("#!/usr/bin/env bash\nexit 0\n");
    await writeMockClaude(LOGGING_CLAUDE);

    const result = await runWrapper();
    expect(result.exitCode).toBe(0);

    expect(await Bun.file(join(tmp, "updater-ran")).exists()).toBe(false);
    expect(await readLog()).toHaveLength(1);
  });

  test("runs ensure-binary.sh before launch when no binary is installed", async () => {
    await writeUpdater(`#!/usr/bin/env bash
touch "$HOME/updater-ran"
exit 0
`);
    await writeMockClaude(LOGGING_CLAUDE);

    const result = await runWrapper();
    expect(result.exitCode).toBe(0);

    expect(await Bun.file(join(tmp, "updater-ran")).exists()).toBe(true);
    const records = await readLog();
    expect(records).toHaveLength(1);
  });

  test("a failing ensure-binary.sh warns but does not abort the launch", async () => {
    await writeUpdater(`#!/usr/bin/env bash
echo "boom" >&2
exit 1
`);
    await writeMockClaude(LOGGING_CLAUDE);

    const result = await runWrapper();
    // set -e must not let the updater's non-zero exit kill the launch.
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("binary update check failed");

    const records = await readLog();
    expect(records).toHaveLength(1);
  });

  test.each([
    "keys",
    "sync",
  ])("`mimir %s …` dispatches to mimir-cc and never launches claude", async (subcommand) => {
    await writeMockBinary(`#!/usr/bin/env bash
echo "binary args=$*" >> "$MIMIR_LOG"
echo "---" >> "$MIMIR_LOG"
exit 3
`);
    await writeMockClaude(LOGGING_CLAUDE);

    const result = await runWrapper([subcommand, "status"]);
    expect(result.exitCode).toBe(3);

    const records = await readLog();
    expect(records).toHaveLength(1);
    expect(records[0]).toBe(`binary args=${subcommand} status`);
  });
});
