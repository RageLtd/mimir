import { describe, expect, test } from "bun:test";
import { buildWorkerPrompt, extractWorkerSections } from "./prompt";
import { WORKER_DEFINITIONS, workerByName } from "./roles";

const XML = [
  "<preamble>I am Mimir.</preamble>",
  "<response_format>Prose.</response_format>",
  "<working_rules>Read before editing.\n\nPresent a plan before executing.</working_rules>",
  "<tool_usage>\n<codebase_navigation>Use Cartographer.</codebase_navigation>\n</tool_usage>",
  "<required_patterns>\n<code_quality>Run formatters.</code_quality>\n</required_patterns>",
  "<executing_actions_with_care>\n<git_safety>Commit only when asked.</git_safety>\n</executing_actions_with_care>",
  "<longrunning_tasks>Background builds.</longrunning_tasks>",
  "<project_rules>Rules files are binding.</project_rules>",
  "<professional_conduct>Say so.\n<error_handling>Own mistakes once.</error_handling>\n</professional_conduct>",
  "<identity_and_voice>Scottish-tinged.</identity_and_voice>",
].join("\n\n");

describe("extractWorkerSections", () => {
  test("keeps the working sections in order and drops persona", () => {
    const sections = extractWorkerSections(XML);
    expect(sections.map((s) => s.slice(0, s.indexOf(">") + 1))).toEqual([
      "<working_rules>",
      "<tool_usage>",
      "<required_patterns>",
      "<executing_actions_with_care>",
      "<longrunning_tasks>",
      "<project_rules>",
      "<error_handling>",
    ]);
    const joined = sections.join("\n");
    expect(joined).toContain("Use Cartographer.");
    expect(joined).toContain("Own mistakes once.");
    expect(joined).not.toContain("Scottish");
    expect(joined).not.toContain("Prose.");
    expect(joined).not.toContain("Say so.");
  });

  test("missing sections are skipped, not blanks", () => {
    expect(extractWorkerSections("<working_rules>x</working_rules>")).toEqual([
      "<working_rules>x</working_rules>",
    ]);
  });
});

describe("buildWorkerPrompt", () => {
  test("role line and contract come last, with the STATUS protocol", () => {
    const impl = workerByName("mimir-impl");
    if (!impl) throw new Error("mimir-impl missing");
    const prompt = buildWorkerPrompt(XML, impl);
    expect(prompt.indexOf("<working_rules>")).toBeLessThan(
      prompt.indexOf("<role>"),
    );
    expect(prompt.indexOf("<role>")).toBeLessThan(
      prompt.indexOf("<worker_contract>"),
    );
    expect(prompt).toContain("mimir-impl");
    expect(prompt).toContain("STATUS: done");
    expect(prompt).toContain("STATUS: blocked");
    expect(prompt).toContain("STATUS: question");
    expect(prompt).toContain("Never push");
    expect(prompt).toContain("Do not wait for approval");
  });

  test("each role gets its own line", () => {
    const lines = WORKER_DEFINITIONS.map(
      (w) =>
        buildWorkerPrompt("", w).match(/<role>\n([\s\S]*?)\n<\/role>/)?.[1] ??
        "",
    );
    expect(lines[0]).toContain("may not create or modify test files");
    expect(lines[1]).toContain("may only create or modify test files");
    expect(lines[2]).toContain("read-only");
    expect(new Set(lines).size).toBe(3);
  });
});
