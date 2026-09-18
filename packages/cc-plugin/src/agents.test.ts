import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { WORKER_DEFINITIONS } from "@mimir/plugin-core/workers";
import { AGENTS_DIR, renderAgentMarkdown, renderSeedAgents } from "./agents";

const XML =
  "<working_rules>Read first.</working_rules>\n<identity_and_voice>Mimir.</identity_and_voice>";

const workerNamed = (name: string) => {
  const worker = WORKER_DEFINITIONS.find((w) => w.name === name);
  if (!worker) throw new Error(`no worker ${name}`);
  return worker;
};

describe("renderAgentMarkdown", () => {
  test("frontmatter carries name, description, turns, worktree isolation; no hooks, no model", () => {
    const md = renderAgentMarkdown(workerNamed("mimir-impl"), XML);
    const [, frontmatter, body] = md.split("---\n");
    expect(frontmatter).toContain("name: mimir-impl\n");
    expect(frontmatter).toContain("maxTurns: 40\n");
    expect(frontmatter).toContain("isolation: worktree\n");
    expect(frontmatter).not.toContain("disallowedTools");
    expect(frontmatter).not.toContain("hooks");
    expect(frontmatter).not.toContain("model");
    expect(body).toContain("Read first.");
    expect(body).not.toContain("Mimir.");
  });

  test("description is JSON-quoted so YAML survives its punctuation", () => {
    const worker = workerNamed("mimir-impl");
    const md = renderAgentMarkdown(worker, XML);
    expect(md).toContain(`description: ${JSON.stringify(worker.description)}`);
  });

  test("review lists its disallowed tools comma-separated", () => {
    const md = renderAgentMarkdown(workerNamed("mimir-review"), XML);
    expect(md).toContain(
      "disallowedTools: Write, Edit, MultiEdit, NotebookEdit\n",
    );
  });
});

describe("committed agents", () => {
  test("agents/*.md match the renderer — run `bun run agents:render` if not", async () => {
    const rendered = await renderSeedAgents();
    expect(rendered.map((a) => a.file)).toEqual([
      "mimir-impl.md",
      "mimir-test.md",
      "mimir-review.md",
    ]);
    for (const agent of rendered) {
      const committed = await Bun.file(join(AGENTS_DIR, agent.file)).text();
      expect(committed).toBe(agent.content);
    }
  });
});
