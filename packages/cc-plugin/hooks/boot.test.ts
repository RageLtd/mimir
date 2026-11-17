/**
 * The boot block rides `prompt.submit`: the session's first prompt carries
 * it (and every reset, submit-window.test.ts), and nothing of the module
 * answers `prompt.context` any more.
 */

import { expect, test } from "claude-code/testing";
import {
  ANCHOR,
  BIN,
  BOOT,
  BOOT_FAILED,
  CONTEXT,
  CWD,
  exited,
  parsed,
  RETRIEVED_STATUS,
  retrieved,
  runsOf,
  SESSION,
  submitSession,
  submitted,
} from "./__tests__/submit-fixtures";

const ENGINE_BLOCKS = [{ name: "claudeMd", text: "# rules" }];

/** Every turn an anchor turn, so the first prompt runs all three legs. */
const EVERY_TURN = { MIMIR_ANCHOR_INTERVAL: "1" };

const answering = (boot: () => ReturnType<typeof exited>) => (sub: string) =>
  sub === "boot-context"
    ? boot()
    : sub === "retrieve"
      ? exited(0, retrieved(CONTEXT, RETRIEVED_STATUS))
      : sub === "voice-anchor"
        ? exited(0, ANCHOR)
        : exited(0);

test("the session's first prompt runs mimir-cc boot-context with its cwd and id, and carries the block beside retrieval's", async ($, on) => {
  const { say, runs } = submitSession(
    on,
    {},
    answering(() => exited(0, `${BOOT}\n`)),
  );

  say([]);
  const result = await $.prompt.submit(submitted("hello", ["prior"]));

  expect(runsOf(runs, "boot-context")).toEqual([
    {
      argv: [BIN, "boot-context"],
      payload: JSON.stringify({ cwd: CWD, session_id: SESSION }),
      env: { MIMIR_ACTIVE: "1" },
    },
  ]);
  expect(result).toMatchObject({ text: "hello" });
  const context = "context" in result ? result.context : undefined;
  expect(context).toHaveLength(3);
  expect(context).toContain("prior");
  expect(context).toContain(CONTEXT);
  expect(context).toContain(BOOT);
});

test("a boot-context run with nothing to say adds nothing", async ($, on) => {
  const { say } = submitSession(
    on,
    {},
    answering(() => exited(0, "\n")),
  );

  say([]);
  const result = await $.prompt.submit(submitted("hello", ["prior"]));

  expect(result).toEqual({ text: "hello", context: ["prior", CONTEXT] });
});

const FAILURES = [
  ["exits non-zero", () => exited(3)],
  [
    "cannot be run",
    () => {
      throw new Error("ENOENT");
    },
  ],
] as const;

for (const [how, boot] of FAILURES) {
  test(`a boot-context run that ${how} shows a status line and costs nothing else`, async ($, on) => {
    const { say, runs, statuses } = submitSession(
      on,
      EVERY_TURN,
      answering(boot),
    );

    say([]);
    const result = await $.prompt.submit(submitted("hello", ["prior"]));

    expect(result).toEqual({
      text: "hello",
      context: ["prior", CONTEXT, ANCHOR],
    });
    expect(statuses.filter((s) => s?.startsWith("mimir:"))).toHaveLength(1);
    expect(
      statuses.filter((s) => s !== undefined && BOOT_FAILED.test(s)),
    ).toHaveLength(1);
    expect(statuses).toContain(RETRIEVED_STATUS);
    expect(
      runsOf(runs, "retrieve").map((run) => parsed(run.payload)),
    ).toMatchObject([{ prompt: "hello", session_start: true }]);
  });
}

test("the module registers nothing on prompt.context: the engine's blocks pass untouched and no binary runs", async ($, on) => {
  const { runs, statuses } = submitSession(
    on,
    {},
    answering(() => exited(0, BOOT)),
  );
  on("prompt.context", (_, e) => ({ blocks: e.blocks }));

  const { blocks } = await $.prompt.context({ blocks: ENGINE_BLOCKS });

  expect(blocks).toEqual(ENGINE_BLOCKS);
  expect(runs).toEqual([]);
  expect(statuses).toEqual([]);
});
