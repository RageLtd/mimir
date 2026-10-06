import { expect, test } from "bun:test";
import { appendToolText, toolInput, toolText } from "./v2-tool-results";

test("append model-visible text without losing files or structured output", () => {
  const result = {
    output: { count: 2 },
    metadata: { sessionID: "worker" },
    content: [
      { type: "text", text: "original" },
      { type: "file", uri: "file:///image.png", mime: "image/png" },
    ],
  } as const;
  const updated = appendToolText(result, "\ncontext");
  expect(toolText(updated)).toBe("original\n\ncontext");
  expect(updated.output).toEqual(result.output);
  expect(updated.metadata).toEqual(result.metadata);
  expect(updated.content).toHaveLength(3);
  expect(result.content).toHaveLength(2);
});

test("string content remains string content", () => {
  expect(appendToolText({ content: "original" }, " more").content).toBe(
    "original more",
  );
  expect(toolText({ output: "not model-visible" })).toBe("");
});

test("hook input normalization rejects non-records", () => {
  expect(toolInput(null)).toEqual({});
  expect(toolInput(["x"])).toEqual({});
  expect(toolInput({ filePath: "src/a.ts" })).toEqual({ filePath: "src/a.ts" });
});
