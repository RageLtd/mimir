import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { readProjectRules } from "./project-rules";
import { writeShippedRules } from "./shipped";

const TMP = join(import.meta.dir, ".tmp-shipped-rules-test");
const HOME = join(TMP, "mimir-home");
const savedHome = process.env.MIMIR_HOME;

beforeEach(() => {
  process.env.MIMIR_HOME = HOME;
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  if (savedHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = savedHome;
});

test("an install lands Mimir's rules where every project then reads them", async () => {
  await writeShippedRules();

  const entries = await readProjectRules(join(TMP, "a-project-with-no-rules"));

  expect(entries.map((e) => e.path)).toEqual([
    "mimir/rules/calling-code-first.md",
    "mimir/rules/data-for-the-loop.md",
    "mimir/rules/layers-and-dependencies.md",
    "mimir/rules/no-needless-work.md",
    "mimir/rules/operation-over-type.md",
    "mimir/rules/reachable-states-only.md",
  ]);
  expect(entries[3]?.content).toStartWith("# Do no work the problem does not");
});
