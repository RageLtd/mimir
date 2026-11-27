import { describe, expect, test } from "bun:test";
import { join } from "node:path";
// Through the package export, as a consumer in another package imports it.
import {
  SHARED_SKILL_ROOTS,
  SHARED_SKILLS,
} from "@mimir/plugin-core/skills/shared";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PACKAGE_JSON = join(import.meta.dir, "..", "..", "package.json");

/** Each skill in the set, and the source folder its markdown lives in. */
const SOURCE_FOLDERS: Readonly<Record<string, string>> = {
  "ui-testing": "testing",
  "unit-testing": "testing",
  "integration-testing": "testing",
  "end-to-end-testing": "testing",
  "bug-tickets": "tickets",
  "story-tickets": "tickets",
  "task-tickets": "tickets",
  "epic-tickets": "tickets",
  documentation: "documentation",
  "code-comments": "documentation",
  "less-code": "coding",
  refactor: "refactor",
};
const NAMES = Object.keys(SOURCE_FOLDERS);
const ROOTS = ["packages/cc-plugin/skills", "packages/codex-plugin/skills"];
/** Where the refactor skill used to ship as a slash command. */
const RETIRED_REFACTOR_COMMANDS = [
  "packages/cc-plugin/commands/refactor.md",
  "packages/oc-plugin/commands/refactor.md",
];

const frontmatterOf = (file: string) =>
  file.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";

describe("shared skills", () => {
  test("are the testing, ticket, documentation, coding and refactor skills, and no others", () => {
    expect(Object.keys(SHARED_SKILLS).sort()).toEqual([...NAMES].sort());
  });

  test("ship under the cc-plugin and codex-plugin skills directories", () => {
    expect([...SHARED_SKILL_ROOTS].sort()).toEqual(ROOTS);
  });

  test("are the package's only skills export", async () => {
    const { exports } = await Bun.file(PACKAGE_JSON).json();
    const skillExports = Object.keys(exports).filter((path) =>
      path.startsWith("./skills"),
    );
    expect(skillExports).toEqual(["./skills/shared"]);
  });

  for (const path of RETIRED_REFACTOR_COMMANDS) {
    test(`refactor is a skill, not a slash command: ${path} is gone`, async () => {
      expect(await Bun.file(join(REPO_ROOT, path)).exists()).toBe(false);
    });
  }

  for (const [name, folder] of Object.entries(SOURCE_FOLDERS)) {
    describe(name, () => {
      const source = SHARED_SKILLS[name] ?? "";

      test("is its whole SKILL.md source", async () => {
        const file = await Bun.file(
          join(import.meta.dir, folder, `${name}.md`),
        ).text();
        expect(source).toBe(file);
      });

      test("is named after its folder, as the hosts' skill format requires", () => {
        expect(frontmatterOf(source)).toMatch(
          new RegExp(`^name: ${name}$`, "m"),
        );
      });

      test("says in its frontmatter when to use it", () => {
        expect(frontmatterOf(source)).toMatch(/^description: \S/m);
      });

      for (const root of ROOTS) {
        test(`the copy committed under ${root} is the source`, async () => {
          const copy = Bun.file(join(REPO_ROOT, root, name, "SKILL.md"));
          expect(await copy.exists()).toBe(true);
          expect(await copy.text()).toBe(source);
        });
      }
    });
  }
});
