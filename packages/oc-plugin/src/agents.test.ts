import { describe, expect, test } from "bun:test";
import type { WorkerRoleModels } from "@mimir/plugin-core/shared-config";
import { WORKER_DEFINITIONS, workerByName } from "@mimir/plugin-core/workers";
import { renderWorkerAgents, renderWorkerFrontmatter } from "./agents";

const need = (name: string) => {
  const w = workerByName(name);
  if (!w) throw new Error(`${name} missing`);
  return w;
};

const OPENCODE_MODEL = "anthropic/claude-opus-4";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The `---` block of an agent file, parsed as YAML — OpenCode reads it
 *  the same way, so a value that only looks right as text is not enough. */
const frontmatterOf = (text: string) => {
  if (!text.startsWith("---\n")) throw new Error("no frontmatter fence");
  const rest = text.slice(4);
  const end = rest.indexOf("\n---");
  if (end === -1) throw new Error("unterminated frontmatter");
  const parsed = Bun.YAML.parse(rest.slice(0, end));
  if (!isRecord(parsed)) throw new Error("frontmatter is not a mapping");
  return parsed;
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

  test("a model pins the agent, quoted", () => {
    const fm = renderWorkerFrontmatter(need("mimir-impl"), OPENCODE_MODEL);
    // JSON-quoted like description: an unquoted "provider/model" would
    // still parse, but the quoting is what keeps odd ids intact. Key
    // order in the frontmatter is not a contract, so the assertions
    // below are all order-independent.
    expect(fm).toContain(`model: ${JSON.stringify(OPENCODE_MODEL)}`);
    expect(frontmatterOf(`${fm}\n`).model).toBe(OPENCODE_MODEL);
    // Pinning a model adds a key, it does not displace the mode the
    // worker is spawned under.
    expect(frontmatterOf(`${fm}\n`).mode).toBe("subagent");
    // Emitted once — a duplicate key is last-one-wins in YAML, so a
    // second line would silently decide the model.
    expect(fm.match(/^model:/gm)?.length).toBe(1);
  });

  test("no model argument leaves the key out entirely", () => {
    const fm = renderWorkerFrontmatter(need("mimir-impl"));
    expect(frontmatterOf(`${fm}\n`)).not.toHaveProperty("model");
    expect(fm).not.toContain("model:");
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

  test("only the roles present in models carry a model key", () => {
    const files = renderWorkerAgents("# Working Rules\n\nRead first.", {
      review: OPENCODE_MODEL,
    });

    expect(frontmatterOf(files["mimir-review.md"] ?? "").model).toBe(
      OPENCODE_MODEL,
    );
    expect(frontmatterOf(files["mimir-impl.md"] ?? "")).not.toHaveProperty(
      "model",
    );
    expect(frontmatterOf(files["mimir-test.md"] ?? "")).not.toHaveProperty(
      "model",
    );
  });

  test("every role can be pinned independently", () => {
    // Typed as the shared role map so the renderer is held to
    // plugin-core's shape, not a local look-alike.
    const models: WorkerRoleModels = {
      impl: "anthropic/claude-sonnet-4",
      test: "openai/gpt-5-mini",
      review: OPENCODE_MODEL,
    };
    const files = renderWorkerAgents("# Working Rules\n\nRead first.", models);

    for (const worker of WORKER_DEFINITIONS) {
      expect(frontmatterOf(files[`${worker.name}.md`] ?? "").model).toBe(
        models[worker.role],
      );
    }
  });

  test("called without models, no agent file names one", () => {
    const files = renderWorkerAgents("# Working Rules\n\nRead first.");
    for (const worker of WORKER_DEFINITIONS) {
      expect(
        frontmatterOf(files[`${worker.name}.md`] ?? ""),
      ).not.toHaveProperty("model");
    }
  });
});
