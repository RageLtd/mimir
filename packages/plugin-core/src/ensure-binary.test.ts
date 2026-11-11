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
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(import.meta.dir, "..", "scripts", "ensure-binary.sh");

const SYSTEM_PATH = "/usr/bin:/bin";
const SH = "/bin/sh";
/** Everything the script runs short of a download. No gh, no curl. */
const TOOLS = ["uname", "cat", "mkdir", "rm", "dirname", "chmod", "mv"];

let home = "";

// A PATH holding only TOOLS. "/usr/bin:/bin" is not enough: GitHub's runners
// ship gh in /usr/bin, so the script found it and asked GitHub for real.
const toolBin = () => join(home, "toolbin");

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mimir-ensure-"));
  await mkdir(join(home, ".mimir"), { recursive: true });
  await mkdir(toolBin());
  for (const tool of TOOLS) {
    const path = Bun.which(tool, { PATH: SYSTEM_PATH });
    if (!path) throw new Error(`${tool} not found on ${SYSTEM_PATH}`);
    await symlink(path, join(toolBin(), tool));
  }
});

afterEach(async () => {
  if (home) await rm(home, { recursive: true, force: true });
});

const run = async (...args: string[]) => {
  // No gh or curl on PATH, so a regression that falls through to the network
  // path fails the test loudly instead of hitting GitHub.
  const proc = Bun.spawn([SH, scriptPath, ...args], {
    env: { HOME: home, PATH: toolBin() },
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

// --- a pinned version (the plugin's own) -------------------------------------

const BINARY = () => join(home, ".local", "bin", "mimir-cc");
const GH_LOG = () => join(home, "gh.log");

/** A `gh` that logs its arguments and writes whatever `--output` names. */
const FAKE_GH = `#!/bin/sh
echo "$*" >> "$HOME/gh.log"
while [ $# -gt 0 ]; do
  if [ "$1" = "--output" ]; then echo "#!/bin/sh" > "$2"; fi
  shift
done
`;

const installed = async (tag: string) => {
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  await writeFile(BINARY(), "old build\n");
  await chmod(BINARY(), 0o755);
  await writeFile(join(home, ".mimir", ".cc-version"), `${tag}\n`);
};

const runWithGh = async (...args: string[]) => {
  const bin = join(home, "fakebin");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "gh"), FAKE_GH);
  await chmod(join(bin, "gh"), 0o755);
  const proc = Bun.spawn([SH, scriptPath, ...args], {
    env: { HOME: home, PATH: `${bin}:${toolBin()}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  return {
    exitCode: proc.exitCode ?? -1,
    stderr: await new Response(proc.stderr).text(),
    gh: (await Bun.file(GH_LOG()).exists())
      ? await Bun.file(GH_LOG()).text()
      : "",
  };
};

test("a pinned version already installed asks GitHub nothing", async () => {
  await installed("cc-plugin/v1.2.3");

  const { exitCode, gh } = await runWithGh("cc", "1.2.3");

  expect(exitCode).toBe(0);
  expect(gh).toBe("");
  expect(await Bun.file(BINARY()).text()).toBe("old build\n");
});

test("a pinned version that differs is fetched by its own tag, never the latest", async () => {
  await installed("cc-plugin/v9.9.9");

  const { exitCode, gh } = await runWithGh("cc", "1.2.3");

  expect(exitCode).toBe(0);
  expect(gh).toContain("release download cc-plugin/v1.2.3");
  expect(gh).not.toContain("release list");
  expect(await Bun.file(BINARY()).text()).toBe("#!/bin/sh\n");
  expect(
    (await Bun.file(join(home, ".mimir", ".cc-version")).text()).trim(),
  ).toBe("cc-plugin/v1.2.3");
});

test("a fetch lands beside the binary and is moved over it, so a running one is never written in place", async () => {
  await installed("cc-plugin/v9.9.9");

  const { gh } = await runWithGh("cc", "1.2.3");

  expect(gh).toContain("--output");
  expect(gh).not.toContain(`--output ${BINARY()} `);
});

test("a pinned version that cannot be fetched fails loudly, even with a binary installed", async () => {
  await installed("cc-plugin/v9.9.9");

  const { exitCode, stderr } = await run("cc", "1.2.3");

  expect(exitCode).toBe(1);
  expect(stderr).toContain("Need either gh");
});

test("a dev pin wins over a pinned version", async () => {
  await pin(".cc-dev");

  const { exitCode, stderr } = await run("cc", "1.2.3");

  expect(exitCode).toBe(0);
  expect(stderr).toContain("dev build pinned");
});

test("a pinned version that is not a version exits 1", async () => {
  const { exitCode, stderr } = await run("cc", "latest; rm -rf");

  expect(exitCode).toBe(1);
  expect(stderr).toContain("Not a version");
});

test("unknown flavor exits 1 with a loud error", async () => {
  const { exitCode, stderr } = await run("opencode");

  expect(exitCode).toBe(1);
  expect(stderr).toContain("Unknown flavor: opencode");
});
