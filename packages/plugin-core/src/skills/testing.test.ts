import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { TESTING_SKILL_ROOTS, TESTING_SKILLS } from "./testing";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

const frontmatterOf = (file: string) =>
  file.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";

describe("testing skills", () => {
  for (const [name, source] of Object.entries(TESTING_SKILLS)) {
    describe(name, () => {
      test("is named after its folder, as the hosts' skill format requires", () => {
        expect(frontmatterOf(source)).toMatch(
          new RegExp(`^name: ${name}$`, "m"),
        );
      });

      test("says in its frontmatter when to use it", () => {
        expect(frontmatterOf(source)).toMatch(/^description: \S/m);
      });

      for (const root of TESTING_SKILL_ROOTS) {
        test(`the copy committed under ${root} is the source`, async () => {
          const committed = await Bun.file(
            join(REPO_ROOT, root, name, "SKILL.md"),
          ).text();
          expect(committed).toBe(source);
        });
      }
    });
  }
});
