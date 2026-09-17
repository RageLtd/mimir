import { describe, expect, test } from "bun:test";
import { renderAgents, renderAgentsJson } from "./agents";

const XML =
  "<working_rules>Read first.</working_rules>\n<identity_and_voice>Mimir.</identity_and_voice>";

describe("renderAgents", () => {
  test("three workers, each with its own guard hook and no persona", () => {
    const agents = renderAgents(XML, "/usr/local/bin/mimir-cc");
    expect(Object.keys(agents)).toEqual([
      "mimir-impl",
      "mimir-test",
      "mimir-review",
    ]);

    const impl = agents["mimir-impl"];
    expect(impl?.maxTurns).toBe(40);
    expect(impl?.isolation).toBe("worktree");
    expect(impl?.hooks.PreToolUse[0]?.hooks[0]?.command).toBe(
      "/usr/local/bin/mimir-cc guard --role impl",
    );
    expect(impl?.prompt).toContain("Read first.");
    expect(impl?.prompt).not.toContain("Mimir.");
    expect(impl?.disallowedTools).toBeUndefined();

    const review = agents["mimir-review"];
    expect(review?.disallowedTools).toEqual([
      "Write",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
    ]);
    expect(review?.hooks.PreToolUse[0]?.hooks[0]?.command).toContain(
      "--role review",
    );
  });

  test("no model field — every role runs the session's model", () => {
    for (const agent of Object.values(renderAgents(XML, "/bin/mimir-cc"))) {
      expect(agent).not.toHaveProperty("model");
    }
  });

  test("renderAgentsJson is valid JSON that round-trips", () => {
    const text = renderAgentsJson(XML, "/bin/mimir-cc");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(renderAgents(XML, "/bin/mimir-cc"));
  });
});
