import { expect, mock, test } from "claude-code/testing";
import { parsed } from "./__tests__/lifecycle-fixtures";
import { BIN, binary, exited, runsOf, session } from "./support.test-helpers";

const ENSURE_BINARY = "/scripts/ensure-binary.sh";
const START = { source: "startup", cwd: "/work/repo" } as const;

const manifest = (version: unknown) =>
  JSON.stringify({ name: "mimir-cc", version });

const pins = (runs: ReturnType<typeof binary>) =>
  runs.filter((run) => run.argv[1]?.endsWith(ENSURE_BINARY));

test("SessionStart hands its payload, source included, to session-start", async ($, on) => {
  const statuses = session(on);
  mock.clock(on);
  const runs = binary(on);
  on("fs.read", () => ({ value: manifest("1.11.0") }));
  on("classic.SessionStart", () => ({}));

  await $.classic.SessionStart({ source: "resume", cwd: "/work/repo" });

  const [run] = runsOf(runs, "session-start");
  expect(run?.argv).toEqual([BIN, "session-start"]);
  expect(run?.env).toEqual({ MIMIR_ACTIVE: "1" });
  expect(parsed(run?.stdin)).toMatchObject({
    hook_event_name: "SessionStart",
    source: "resume",
    cwd: "/work/repo",
  });
  expect(statuses).toEqual([]);
});

test("session start asks for the binary of the plugin's own version, off the prompt", async ($, on) => {
  const statuses = session(on);
  const clock = mock.clock(on);
  const runs = binary(on);
  const read: string[] = [];
  on("fs.read", (_, e) => {
    read.push(e.path);
    return { value: manifest("1.11.0") };
  });
  on("classic.SessionStart", () => ({}));

  await $.classic.SessionStart(START);

  expect(pins(runs)).toEqual([]);
  await clock.advance(0);

  expect(read).toHaveLength(1);
  expect(read[0]?.endsWith("/.claude-plugin/plugin.json")).toBe(true);
  const [pin] = pins(runs);
  expect(pin?.argv[0]).toBe("/bin/sh");
  expect(pin?.argv.slice(2)).toEqual(["cc", "1.11.0"]);
  expect(statuses).toEqual([]);
});

test("a fetch that fails shows a status line", async ($, on) => {
  const statuses = session(on);
  const clock = mock.clock(on);
  binary(on, (sub) => (sub.endsWith(ENSURE_BINARY) ? exited(1) : exited(0)));
  on("fs.read", () => ({ value: manifest("1.11.0") }));
  on("classic.SessionStart", () => ({}));

  await $.classic.SessionStart(START);
  await clock.advance(0);

  expect(statuses).toEqual([
    "mimir: could not fetch the mimir-cc 1.11.0 binary (exit 1)",
  ]);
});

test("a manifest without a version fetches nothing and says so", async ($, on) => {
  const statuses = session(on);
  const clock = mock.clock(on);
  const runs = binary(on);
  on("fs.read", () => ({ value: manifest("latest; rm -rf") }));
  on("classic.SessionStart", () => ({}));

  await $.classic.SessionStart(START);
  await clock.advance(0);

  expect(pins(runs)).toEqual([]);
  expect(statuses).toEqual(["mimir: plugin.json carries no version"]);
});
