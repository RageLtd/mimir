import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { toAnthropicXml } from "../anthropic-xml";
import {
  buildWorkerPrompt,
  extractWorkerSections,
  WORKER_SECTIONS,
} from "./prompt";
import { WORKER_DEFINITIONS, workerByName } from "./roles";

/** Code Principles ride in on Required Patterns, not on a tag of their own. */
const WORKER_SECTIONS_KEEP_REQUIRED_PATTERNS =
  WORKER_SECTIONS.includes("required_patterns") &&
  !WORKER_SECTIONS.includes("code_principles");

const SEED_PATH = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "server",
  "system-prompt.md",
);

/** Markdown from `heading` to the next heading of the same or a higher level. */
const markdownSection = (markdown: string, heading: string) => {
  const level = heading.indexOf(" ");
  const start = markdown.split("\n").indexOf(heading);
  if (start === -1) return null;
  const lines = markdown.split("\n").slice(start + 1);
  const end = lines.findIndex((line) => {
    const match = /^(#+) /.exec(line);
    return match?.[1] !== undefined && match[1].length <= level;
  });
  return (end === -1 ? lines : lines.slice(0, end)).join("\n");
};

/** The `<code_principles>` body nested in `<required_patterns>`, or "". */
const codePrinciplesIn = (xml: string) => {
  const patterns =
    /<required_patterns>[\s\S]*?<\/required_patterns>/.exec(xml)?.[0] ?? "";
  return (
    /<code_principles>([\s\S]*?)<\/code_principles>/.exec(patterns)?.[1] ?? ""
  );
};

const bulletCount = (text: string) => text.match(/^[-*] /gm)?.length ?? 0;

describe("the seed's Code Principles", () => {
  test("sit under Required Patterns as an opening paragraph and a list of several principles", async () => {
    const seed = await Bun.file(SEED_PATH).text();
    const patterns = markdownSection(seed, "# Required Patterns");
    expect(patterns).not.toBeNull();
    const principles = markdownSection(patterns ?? "", "## Code Principles");
    expect(principles).not.toBeNull();
    const blocks = (principles ?? "")
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .filter((block) => block !== "");
    const opening = blocks[0] ?? "";
    expect(opening).not.toBe("");
    expect(bulletCount(opening)).toBe(0);
    expect(bulletCount(principles ?? "")).toBeGreaterThan(3);
  });

  test("reach every worker role through the sections the extraction already keeps", async () => {
    expect(WORKER_SECTIONS_KEEP_REQUIRED_PATTERNS).toBe(true);
    const xml = toAnthropicXml(await Bun.file(SEED_PATH).text());
    for (const worker of WORKER_DEFINITIONS) {
      const block = codePrinciplesIn(buildWorkerPrompt(xml, worker));
      expect(block.trim()).not.toBe("");
      expect(bulletCount(block)).toBeGreaterThan(3);
    }
  });
});

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

  test("every role is told it does not run git and leaves its change uncommitted for the coordinator", async () => {
    const seedXml = toAnthropicXml(await Bun.file(SEED_PATH).text());
    for (const worker of WORKER_DEFINITIONS) {
      // With no prompt sections, the instruction must come from the
      // worker's own role line or contract; with the seed, it must survive.
      for (const prompt of [
        buildWorkerPrompt("", worker),
        buildWorkerPrompt(seedXml, worker),
      ]) {
        expect({ worker: worker.name, prompt }).toEqual({
          worker: worker.name,
          prompt: expect.stringMatching(
            /(?:do(?:es)? not|never|don't) (?:run|use) git/i,
          ),
        });
        expect({ worker: worker.name, prompt }).toEqual({
          worker: worker.name,
          prompt: expect.stringMatching(/uncommitted[^.]*coordinator/i),
        });
      }
    }
  });
});
