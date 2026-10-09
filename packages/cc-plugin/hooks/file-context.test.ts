import type { On } from "claude-code";
import { expect, test } from "claude-code/testing";
import {
  BIN,
  binary,
  CWD,
  exited,
  nudged,
  runsOf,
  SESSION,
  session,
} from "./support.test-helpers";

const READ = { tool: "Read", file_path: "/work/repo/src/a.ts" } as const;
const READ_RESULT = {
  type: "text" as const,
  file: {
    filePath: READ.file_path,
    content: "export const a = 1;",
    numLines: 1,
    startLine: 1,
    totalLines: 1,
  },
};
const BLOCK =
  '<file_context path="/work/repo/src/a.ts">\n<symbols>\n- const a (line 1)\n</symbols>\n</file_context>';

const readTool = (on: On) =>
  on("tool.call", { tool: "Read" }, () => ({ result: READ_RESULT }));

test("runs file-context beside the read and attaches its block as context", async ($, on) => {
  const statuses = session(on);
  const runs = binary(on, (sub) =>
    sub === "file-context"
      ? exited(0, nudged(BLOCK, "↻ File context: 2 dependents, 1 memories"))
      : exited(0),
  );
  readTool(on);

  const result = await $.tool.call(READ);

  expect(runsOf(runs, "file-context")).toEqual([
    {
      argv: [BIN, "file-context"],
      stdin: JSON.stringify({
        session_id: SESSION,
        hook_event_name: "PreToolUse",
        cwd: CWD,
        tool_name: "Read",
        tool_input: { file_path: READ.file_path },
      }),
      env: { MIMIR_ACTIVE: "1" },
    },
  ]);
  expect(result.result).toEqual(READ_RESULT);
  expect(result.context).toEqual([BLOCK]);
  expect(statuses).toEqual(["↻ File context: 2 dependents, 1 memories"]);
});

test("a read of a file the index has nothing on comes back untouched", async ($, on) => {
  const statuses = session(on);
  binary(on);
  readTool(on);

  const result = await $.tool.call(READ);

  expect(result.result).toEqual(READ_RESULT);
  expect(result.context).toBeUndefined();
  expect(statuses).toEqual([]);
});

test("a failing binary costs the context, not the read", async ($, on) => {
  const statuses = session(on);
  binary(on, (sub) => (sub === "file-context" ? exited(2) : exited(0)));
  readTool(on);

  const result = await $.tool.call(READ);

  expect(result.result).toEqual(READ_RESULT);
  expect(statuses).toEqual(["mimir: file context failed (exit 2)"]);
});
