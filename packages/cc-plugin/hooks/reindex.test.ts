import { expect, test } from "claude-code/testing";
import {
  BIN,
  binary,
  CWD,
  exited,
  runsOf,
  SESSION,
  session,
} from "./support.test-helpers";

const WRITE = {
  tool: "Write",
  file_path: "/work/repo/src/new.ts",
  content: "export const x = 1;\n",
} as const;
const WRITE_RESULT = {
  type: "create" as const,
  filePath: WRITE.file_path,
  content: WRITE.content,
  structuredPatch: [],
};

test("after a write lands, reindex gets the PostToolUse payload and the result stands", async ($, on) => {
  const statuses = session(on);
  const runs = binary(on);
  on("tool.call", { tool: "Write" }, () => ({ result: WRITE_RESULT }));

  const result = await $.tool.call(WRITE);

  expect(result.result).toEqual(WRITE_RESULT);
  expect(runsOf(runs, "reindex")).toEqual([
    {
      argv: [BIN, "reindex"],
      stdin: JSON.stringify({
        session_id: SESSION,
        hook_event_name: "PostToolUse",
        cwd: CWD,
        tool_name: "Write",
        tool_input: { file_path: WRITE.file_path, content: WRITE.content },
      }),
      env: { MIMIR_ACTIVE: "1" },
    },
  ]);
  expect(statuses).toEqual([]);
});

test("a write that errored is not indexed", async ($, on) => {
  session(on);
  const runs = binary(on);
  on("tool.call", { tool: "Write" }, () => ({
    isError: true as const,
    result: "EACCES",
  }));

  await $.tool.call(WRITE);

  expect(runsOf(runs, "reindex")).toEqual([]);
});

test("a reindex that fails to fork shows a status line and nothing else", async ($, on) => {
  const statuses = session(on);
  binary(on, (sub) => (sub === "reindex" ? exited(1) : exited(0)));
  on("tool.call", { tool: "Write" }, () => ({ result: WRITE_RESULT }));

  const result = await $.tool.call(WRITE);

  expect(result.result).toEqual(WRITE_RESULT);
  expect(statuses).toEqual(["mimir: reindex failed (exit 1)"]);
});

test("a read is not a write", async ($, on) => {
  session(on);
  const runs = binary(on);
  on("tool.call", { tool: "Read" }, () => ({
    result: {
      type: "text" as const,
      file: {
        filePath: "/x",
        content: "",
        numLines: 0,
        startLine: 1,
        totalLines: 0,
      },
    },
  }));

  await $.tool.call({ tool: "Read", file_path: "/x" });

  expect(runsOf(runs, "reindex")).toEqual([]);
});
