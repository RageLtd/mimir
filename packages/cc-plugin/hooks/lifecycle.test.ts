import { expect, test } from "claude-code/testing";
import { BIN, binary, exited, runsOf, session } from "./support.test-helpers";

const parsed = (stdin: string | undefined) => JSON.parse(stdin ?? "{}");

test("SessionStart hands its payload, source included, to session-start", async ($, on) => {
  const statuses = session(on);
  const runs = binary(on);
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

test("Stop hands the transcript path to persist and never blocks the turn", async ($, on) => {
  session(on);
  const runs = binary(on);
  on("classic.Stop", () => ({}));

  const result = await $.classic.Stop({
    stop_hook_active: false,
    transcript_path: "/t/sess-1.jsonl",
    last_assistant_message: "Aye.",
  });

  expect(result).toEqual({});
  const [run] = runsOf(runs, "persist");
  expect(run?.argv).toEqual([BIN, "persist"]);
  expect(parsed(run?.stdin)).toMatchObject({
    hook_event_name: "Stop",
    transcript_path: "/t/sess-1.jsonl",
  });
});

test("PreCompact hands the trigger to precompact", async ($, on) => {
  session(on);
  const runs = binary(on);
  on("classic.PreCompact", () => ({}));

  await $.classic.PreCompact({ trigger: "auto", custom_instructions: null });

  const [run] = runsOf(runs, "precompact");
  expect(run?.argv).toEqual([BIN, "precompact"]);
  expect(parsed(run?.stdin)).toMatchObject({
    hook_event_name: "PreCompact",
    trigger: "auto",
  });
});

test("a failing leg shows a status line and the event passes on", async ($, on) => {
  const statuses = session(on);
  on("classic.Stop", () => ({ additionalContext: ["below"] }));
  on("classic.PreCompact", () => ({}));
  on("process.run", (_, e) => {
    if (e.argv[1] === "precompact") throw new Error("ENOENT");
    return exited(e.argv[1] === "persist" ? 4 : 0);
  });

  const stopped = await $.classic.Stop({ stop_hook_active: false });
  await $.classic.PreCompact({ trigger: "manual", custom_instructions: null });

  expect(stopped).toEqual({ additionalContext: ["below"] });
  expect(statuses).toEqual([
    "mimir: persist failed (exit 4)",
    "mimir: precompact failed",
  ]);
});
