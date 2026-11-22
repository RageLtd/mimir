import { describe, expect, test } from "bun:test";
import { join } from "node:path";
// Through the package export, as a consumer in another package imports it.
import {
  TICKET_SKILL_ROOTS,
  TICKET_SKILLS,
} from "@mimir/plugin-core/skills/tickets";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");
const NAMES = ["bug-tickets", "story-tickets", "task-tickets", "epic-tickets"];
const ROOTS = ["packages/cc-plugin/skills", "packages/codex-plugin/skills"];

const frontmatterOf = (file: string) =>
  file.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";

describe("ticket skills", () => {
  test("are the bug, story, task and epic skills", () => {
    expect(Object.keys(TICKET_SKILLS).sort()).toEqual([...NAMES].sort());
  });

  test("ship under the cc-plugin and codex-plugin skills directories", () => {
    expect([...TICKET_SKILL_ROOTS].sort()).toEqual(ROOTS);
  });

  for (const name of NAMES) {
    describe(name, () => {
      const source = TICKET_SKILLS[name] ?? "";

      test("is its whole SKILL.md source", async () => {
        const file = await Bun.file(
          join(import.meta.dir, "tickets", `${name}.md`),
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
