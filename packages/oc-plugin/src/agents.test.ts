import { describe, expect, test } from "bun:test";
import { WORKER_DEFINITIONS, workerByName } from "@mimir/plugin-core/workers";
import { renderWorkerAgents, renderWorkerFrontmatter } from "./agents";

const need = (name: string) => {
  const w = workerByName(name);
  if (!w) throw new Error(`${name} missing`);
  return w;
};

describe("renderWorkerFrontmatter", () => {
  test("impl: edits allowed except test paths, broad rule first", () => {
    const fm = renderWorkerFrontmatter(need("mimir-impl"));
    expect(fm).toContain("mode: subagent");
    expect(fm).toContain("steps: 40");
    expect(fm).toContain("  task: deny");
    const edit = fm.slice(fm.indexOf("  edit:"), fm.indexOf("  bash:"));
    expect(edit.indexOf('"*": allow')).toBeLessThan(
      edit.indexOf('"*.test.*": deny'),
    );
    expect(edit).toContain('"*_test.go": deny');
    expect(fm).toContain('"git push*": deny');
    expect(fm).toContain('"*/.ssh/*": deny');
  });

  test("test: edits denied except test paths", () => {
    const fm = renderWorkerFrontmatter(need("mimir-test"));
    const edit = fm.slice(fm.indexOf("  edit:"), fm.indexOf("  bash:"));
    expect(edit.indexOf('"*": deny')).toBeLessThan(
      edit.indexOf('"*.test.*": allow'),
    );
  });

  test("review: no edits, git inspection only", () => {
    const fm = renderWorkerFrontmatter(need("mimir-review"));
    const edit = fm.slice(fm.indexOf("  edit:"), fm.indexOf("  bash:"));
    expect(edit.trim()).toBe('edit:\n    "*": deny');
    const bash = fm.slice(fm.indexOf("  bash:"), fm.indexOf("  read:"));
    expect(bash.indexOf('"*": deny')).toBeLessThan(
      bash.indexOf('"git diff*": allow'),
    );
    expect(bash).not.toContain("git push");
  });
});

describe("renderWorkerAgents", () => {
  test("one file per worker with the persona-less prompt as the body", () => {
    const md =
      "# Working Rules\n\nRead first.\n\n# Identity And Voice\n\nScottish.";
    const files = renderWorkerAgents(md);
    expect(Object.keys(files).sort()).toEqual(
      WORKER_DEFINITIONS.map((w) => `${w.name}.md`).sort(),
    );
    const impl = files["mimir-impl.md"] ?? "";
    expect(impl.startsWith("---\n")).toBe(true);
    expect(impl).toContain("<working_rules>");
    expect(impl).toContain("Read first.");
    expect(impl).not.toContain("Scottish");
    expect(impl).toContain("STATUS: done");
  });
});
