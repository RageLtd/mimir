import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { delegateTool, reviewPromptTool } from "./delegate-tools";

const context: ToolContext = {
  ...JSON.parse(
    '{"sessionID":"test-delegate-tools-v2","messageID":"test-message","agent":"mimir","id":"test-call"}',
  ),
  signal: new AbortController().signal,
  progress: async () => {},
};

describe("V2 delegate tools", () => {
  test("preserves the action enum and optional project-relative paths", () => {
    const delegate = delegateTool("/project");
    expect(delegate.input.required).toEqual(["action"]);
    expect(delegate.input.properties.action).toMatchObject({
      type: "string",
      enum: ["start", "status", "stop"],
    });
    expect(reviewPromptTool("/project").input.required).toEqual(["title"]);
  });

  test("wraps coordinator responses and refuses start without a plan", async () => {
    const delegate = delegateTool("/project");
    expect(await delegate.execute({ action: "start" }, context)).toEqual({
      content: "mimir_delegate start needs planFile.",
    });
    expect(await delegate.execute({ action: "status" }, context)).toEqual({
      content: "no active delegation for session test-delegate-tools-v2",
    });
    await expect(
      delegate.execute({ action: "invalid" }, context),
    ).rejects.toThrow("Invalid tool argument: action");
  });

  test("review uses the captured project directory rather than process cwd", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mimir-v2-tool-project-"));
    try {
      expect(
        await reviewPromptTool(directory).execute({ title: "Review" }, context),
      ).toEqual({ content: `${directory} is not a git worktree.` });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
