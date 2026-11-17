import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  REFACTOR_SKILL_BODY,
  REFACTOR_SKILL_FILES,
  renderRefactorSkill,
  type SkillHost,
} from "./refactor";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const HOSTS: readonly SkillHost[] = ["claudeCode", "opencode", "codex"];

const frontmatterOf = (file: string) => {
  const match = file.match(/^---\n([\s\S]*?)\n---\n/);
  return match?.[1] ?? "";
};

describe("refactor skill", () => {
  for (const host of HOSTS) {
    describe(host, () => {
      const rendered = renderRefactorSkill(host);

      test("carries the one shared body", () => {
        expect(rendered).toContain(REFACTOR_SKILL_BODY);
      });

      test("says in its frontmatter when to use it", () => {
        expect(frontmatterOf(rendered)).toMatch(/^description: .*refactor/im);
      });

      test("the committed skill file is this rendering", async () => {
        const committed = await Bun.file(
          join(REPO_ROOT, REFACTOR_SKILL_FILES[host]),
        ).text();
        expect(committed).toBe(rendered);
      });
    });
  }

  test("Codex names the skill, as its skill format requires", () => {
    expect(frontmatterOf(renderRefactorSkill("codex"))).toMatch(
      /^name: refactor$/m,
    );
  });

  test("the command hosts pass the developer's arguments through", () => {
    expect(renderRefactorSkill("claudeCode").endsWith("\n\n$ARGUMENTS\n")).toBe(
      true,
    );
    expect(renderRefactorSkill("opencode").endsWith("\n\n$ARGUMENTS\n")).toBe(
      true,
    );
  });
});
