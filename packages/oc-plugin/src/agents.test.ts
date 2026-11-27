import { describe, expect, test } from "bun:test";
import { join } from "node:path";
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

/** Everything after the closing `---` fence — the role prompt. */
const bodyOf = (text: string) => {
  if (!text.startsWith("---\n")) throw new Error("no frontmatter fence");
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) throw new Error("unterminated frontmatter");
  return text.slice(end + "\n---\n".length);
};

/** The `permission.<tool>` table of an agent's frontmatter, in file order. */
const permissionTable = (fm: string, tool: string) => {
  const permission = frontmatterOf(`${fm}\n`).permission;
  if (!isRecord(permission)) throw new Error("permission is not a mapping");
  const table = permission[tool];
  if (!isRecord(table)) throw new Error(`permission.${tool} is not a table`);
  return Object.entries(table);
};

const escapeRegex = (text: string) => text.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/** How OpenCode resolves a command against a permission table: `*`
 *  matches any run of characters (`/` included), `?` one character, the
 *  whole command must match, and the last matching rule wins. */
const resolve = (table: [string, unknown][], command: string) => {
  let action: unknown;
  for (const [pattern, value] of table) {
    const source = escapeRegex(pattern)
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    if (new RegExp(`^${source}$`, "s").test(command)) action = value;
  }
  return action;
};

const GIT_COMMANDS = [
  "git status",
  "git diff",
  "git log",
  "git show HEAD",
  "git blame src/agents.ts",
  "git commit -m x",
  "git push",
  "git reset --hard",
];

describe("worker bash permissions", () => {
  for (const worker of WORKER_DEFINITIONS) {
    test(`${worker.name}: no git command is allowed`, () => {
      const bash = permissionTable(renderWorkerFrontmatter(worker), "bash");
      for (const command of GIT_COMMANDS) {
        expect({ command, action: resolve(bash, command) }).toEqual({
          command,
          action: "deny",
        });
      }
    });
  }

  for (const name of ["mimir-impl", "mimir-test"]) {
    test(`${name}: ordinary shell commands stay allowed`, () => {
      const bash = permissionTable(renderWorkerFrontmatter(need(name)), "bash");
      expect(resolve(bash, "bun run test")).toBe("allow");
      expect(resolve(bash, "bun test src/agents.test.ts")).toBe("allow");
      expect(resolve(bash, "ls -la")).toBe("allow");
    });
  }

  test("mimir-review: every shell command is denied", () => {
    const bash = permissionTable(
      renderWorkerFrontmatter(need("mimir-review")),
      "bash",
    );
    expect(resolve(bash, "bun run test")).toBe("deny");
    expect(resolve(bash, "ls")).toBe("deny");
  });
});

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
    expect(fm).toContain('"*/.ssh/*": deny');
  });

  test("test: edits denied except test paths", () => {
    const fm = renderWorkerFrontmatter(need("mimir-test"));
    const edit = fm.slice(fm.indexOf("  edit:"), fm.indexOf("  bash:"));
    expect(edit.indexOf('"*": deny')).toBeLessThan(
      edit.indexOf('"*.test.*": allow'),
    );
  });

  test("review: no edits, and no shell allowance for git", () => {
    const fm = renderWorkerFrontmatter(need("mimir-review"));
    const edit = fm.slice(fm.indexOf("  edit:"), fm.indexOf("  bash:"));
    expect(edit.trim()).toBe('edit:\n    "*": deny');
    const bash = permissionTable(fm, "bash");
    expect(bash.filter(([, action]) => action !== "deny")).toEqual([]);
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

  test("each role's body is the text Claude Code's committed worker agent carries", async () => {
    // Both hosts build the body from the shared worker definitions and the
    // same prompt seed; only frontmatter and file framing are host-specific.
    // Claude Code's committed files are read as files, not imported, so
    // this package takes no dependency on cc-plugin.
    const packages = join(import.meta.dir, "..", "..");
    const seed = await Bun.file(
      join(packages, "server", "system-prompt.md"),
    ).text();
    const files = renderWorkerAgents(seed);

    for (const worker of WORKER_DEFINITIONS) {
      const file = `${worker.name}.md`;
      const claudeCode = await Bun.file(
        join(packages, "cc-plugin", "agents", file),
      ).text();
      const body = bodyOf(files[file] ?? "");
      expect(body).toContain("<worker_contract>");
      expect(body).toBe(bodyOf(claudeCode));
    }
  });

  test("each role's body carries the seed's Code Principles inside Required Patterns", async () => {
    const seed = await Bun.file(
      join(import.meta.dir, "..", "..", "server", "system-prompt.md"),
    ).text();
    const files = renderWorkerAgents(seed);

    for (const worker of WORKER_DEFINITIONS) {
      const body = bodyOf(files[`${worker.name}.md`] ?? "");
      const patterns =
        /<required_patterns>[\s\S]*?<\/required_patterns>/.exec(body)?.[0] ??
        "";
      const block =
        /<code_principles>([\s\S]*?)<\/code_principles>/.exec(patterns)?.[1] ??
        "";
      expect(block.trim()).not.toBe("");
      expect(block.match(/^[-*] /gm)?.length ?? 0).toBeGreaterThan(3);
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
