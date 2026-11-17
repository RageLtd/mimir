import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderDelegateCommand } from "@mimir/plugin-core/workers";

const DELEGATE_MD = join(import.meta.dir, "..", "commands", "delegate.md");

describe("committed delegate command", () => {
  test("commands/delegate.md matches the shared coordinator prompt rendered for Claude Code", async () => {
    const committed = await Bun.file(DELEGATE_MD).text();
    expect(committed).toBe(renderDelegateCommand("claudeCode"));
  });
});
