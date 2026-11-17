import { expect, mock, test } from "claude-code/testing";
import {
  anchorState,
  conversation,
  pendingState,
  TURN,
  turnOne,
  turnTwo,
} from "./__tests__/lifecycle-fixtures";
import { anchorOf } from "./messages";
import { binary, payloads, runsOf, session } from "./support.test-helpers";

test("a turn hook that throws names what it caught, and the turn passes on", async ($, on) => {
  const statuses = session(on);
  anchorState(on);
  pendingState(on);
  on("session.messages", () => {
    throw new Error("messages refused");
  });
  const runs = binary(on);
  on("turn.complete", (_, e) => ({ text: e.answer }));

  const result = await $.turn.complete(TURN);

  expect(result).toEqual({ text: "Then this." });
  expect(statuses).toEqual([
    "mimir: persist hook failed (throw: no implementation for session.messages)",
  ]);
  expect(runsOf(runs, "persist")).toEqual([]);
});

test("a deferred persist that cannot run names what it caught and clears pending", async ($, on) => {
  const statuses = session(on);
  const clock = mock.clock(on);
  anchorState(on, anchorOf(turnOne));
  const pending = pendingState(on);
  conversation(on, [...turnOne, ...turnTwo]);
  payloads(on);
  on("process.run", () => {
    throw new Error("ENOENT");
  });
  on("turn.complete", (_, e) => ({ text: e.answer }));

  await $.turn.complete(TURN);
  await clock.advance(0);

  // The reason leads: a status line is cut short, and the leg's name is
  // the part a reader can do without.
  expect(statuses).toEqual([
    "mimir: HooksError: no implementation for process.run (persist run failed)",
  ]);
  expect(pending.get()).toBeNull();
});
