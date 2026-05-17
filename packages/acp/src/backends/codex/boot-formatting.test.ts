import { describe, expect, test } from "bun:test";
import {
  CODEX_CONTEXT_INSTRUCTIONS,
  type CodexBootContent,
  formatCodexBootContent,
  formatCodexInstructions,
} from "./boot-formatting";

const mkContent = (overrides?: Partial<CodexBootContent>): CodexBootContent => ({
  userContext:
    overrides?.userContext ??
    "<user_context>\n<user_profile>\nName: Test\n</user_profile>\n</user_context>",
  projectRules:
    overrides?.projectRules ??
    "<project_rules>\n--- AGENTS.md ---\nNo OOP.\n</project_rules>",
  sessionContext:
    overrides?.sessionContext ??
    "<conversation_context>\n[User]\nhello\n</conversation_context>",
});

describe("formatCodexBootContent", () => {
  test("uses markdown hierarchy and direct XML context blocks", () => {
    const result = formatCodexBootContent(mkContent());
    expect(result.startsWith("# Session Context")).toBe(true);
    expect(result).toContain(CODEX_CONTEXT_INSTRUCTIONS);
    expect(result).toContain("<user_context>");
    expect(result).toContain("</user_context>");
    expect(result).toContain("<project_rules>");
    expect(result).toContain("</project_rules>");
    expect(result).toContain("<conversation_context>");
    expect(result).toContain("</conversation_context>");
    expect(result).not.toContain("<boot_context>");
    expect(result).not.toContain("<user_profile_section>");
  });

  test("does not double-wrap already-tagged content", () => {
    const result = formatCodexBootContent(mkContent());
    expect(result.match(/<user_context>/g)).toHaveLength(1);
    expect(result.match(/<project_rules>/g)).toHaveLength(1);
    expect(result.match(/<conversation_context>/g)).toHaveLength(1);
  });

  test("uses explicit fallbacks for missing context", () => {
    const result = formatCodexBootContent({
      userContext: null,
      projectRules: null,
      sessionContext: null,
    });
    expect(result).toContain("No user profile or memories stored yet");
    expect(result).toContain("No project rules found in this codebase.");
    expect(result).toContain("No prior session context");
  });
});

describe("formatCodexInstructions", () => {
  test("keeps system prompt as plain markdown before boot context", () => {
    const result = formatCodexInstructions("# Mimir\n\nPlain markdown.", mkContent());
    expect(result.startsWith("# Mimir\n\nPlain markdown.\n\n# Session Context")).toBe(
      true,
    );
  });
});
