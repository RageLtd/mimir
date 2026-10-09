import { describe, expect, test } from "bun:test";
import { hostRendersNotices, noticeFor } from "./host";

describe("hostRendersNotices", () => {
  test("the terminal TUI, the desktop app, and an older CLI with no entrypoint all render notices", () => {
    expect(hostRendersNotices({ CLAUDE_CODE_ENTRYPOINT: "cli" })).toBe(true);
    expect(
      hostRendersNotices({ CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }),
    ).toBe(true);
    expect(hostRendersNotices({})).toBe(true);
  });

  test("SDK-driven hosts do not", () => {
    for (const entrypoint of ["sdk-ts", "sdk-py"]) {
      expect(hostRendersNotices({ CLAUDE_CODE_ENTRYPOINT: entrypoint })).toBe(
        false,
      );
    }
  });
});

describe("noticeFor", () => {
  test("attaches the message only where it renders", () => {
    expect(noticeFor("↻ hello", { CLAUDE_CODE_ENTRYPOINT: "cli" })).toEqual({
      systemMessage: "↻ hello",
    });
    expect(noticeFor("↻ hello", { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" })).toEqual(
      {},
    );
  });
});
