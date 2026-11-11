import { expect, test } from "claude-code/testing";
import {
  anchorOf,
  deltaSince,
  type Message,
  NO_ANCHOR,
  slim,
} from "./messages";

const user = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
});
const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

const turnOne = [user("hello"), assistant("Aye.")];
const turnTwo = [user("and then?"), assistant("Then this.")];

test("the first delta is the whole conversation", async () => {
  expect(deltaSince(turnOne, NO_ANCHOR)).toEqual(turnOne);
});

test("an anchor still in place yields the messages after it", async () => {
  const anchor = anchorOf(turnOne);
  expect(anchor.count).toBe(2);
  expect(deltaSince([...turnOne, ...turnTwo], anchor)).toEqual(turnTwo);
  expect(deltaSince(turnOne, anchor)).toEqual([]);
});

test("a slid window is resumed after the anchor's message", async () => {
  const anchor = anchorOf(turnOne);
  // The window dropped its oldest row: the anchored message sits one
  // index earlier than the count says.
  const slid = [assistant("Aye."), ...turnTwo];
  expect(deltaSince(slid, anchor)).toEqual(turnTwo);
});

test("an anchor no longer present yields the whole window", async () => {
  const anchor = anchorOf(turnOne);
  const compacted = [user("summary of what came before"), ...turnTwo];
  expect(deltaSince(compacted, anchor)).toEqual(compacted);
});

test("a row's text and the API form of the same message mark alike", async () => {
  const api: Message = {
    role: "assistant",
    content: [
      { type: "text", text: "one" },
      { type: "tool_use", id: "tu", name: "Read", input: {} },
      { type: "text", text: "two" },
    ],
  };
  const row = { role: "assistant" as const, text: "one\ntwo" };
  expect(anchorOf([row])).toEqual(anchorOf([api]));
});

test("slim drops media at the top level and inside tool results", async () => {
  const message: Message = {
    role: "user",
    content: [
      { type: "image", source: { data: "…" } },
      {
        type: "tool_result",
        tool_use_id: "tu",
        content: [
          { type: "text", text: "kept" },
          { type: "image", source: { data: "…" } },
        ],
      },
      { type: "text", text: "and this" },
    ],
  };
  expect(slim(message)).toEqual({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: "tu",
        content: [{ type: "text", text: "kept" }],
      },
      { type: "text", text: "and this" },
    ],
  });
});
