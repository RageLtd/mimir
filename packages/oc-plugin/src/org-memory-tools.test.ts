import { beforeEach, describe, expect, test } from "bun:test";
import {
  createOrgReplica,
  type OrgReplica,
} from "@mimir/plugin-core/store/org-replica";
import { orgMemoryToolNames } from "@mimir/plugin-core/tools/org-memory";
import { orgMemoryTools } from "./org-memory-tools";

let replica: OrgReplica;

beforeEach(() => {
  replica = createOrgReplica(":memory:");
});

const noEmbedding = async (_text: string) => null;
const context = {
  sessionID: "test-session",
  messageID: "test-message",
  agent: "mimir",
  directory: "/tmp/project",
  worktree: "/tmp/project",
  abort: new AbortController().signal,
  callID: "test-call",
  extra: {},
  metadata: () => {},
  ask: async () => {},
};
const outputText = (result: string | { output: string }) =>
  typeof result === "string" ? result : result.output;

describe("orgMemoryTools", () => {
  test("registers the complete project-memory and playbook surface", () => {
    const tools = orgMemoryTools(replica, noEmbedding);
    expect(Object.keys(tools).sort()).toEqual([...orgMemoryToolNames].sort());
  });

  test("delegates project-memory calls to the local replica", async () => {
    const tools = orgMemoryTools(replica, noEmbedding);
    const stored = JSON.parse(
      outputText(
        await tools.project_memory_store.execute(
          { content: "OpenCode owns local tools" },
          context,
        ),
      ),
    ) as { id: string; stored: boolean };

    expect(stored.stored).toBe(true);

    const search = JSON.parse(
      outputText(
        await tools.project_memory_search.execute(
          { query: "local tools" },
          context,
        ),
      ),
    ) as { results: Array<{ id: string }> };
    expect(search.results.map((result) => result.id)).toContain(stored.id);
  });

  test("gracefully degrades when the replica cannot be opened", async () => {
    const tools = orgMemoryTools(null, noEmbedding);
    const result = await tools.project_memory_list.execute({}, context);
    expect(outputText(result)).toBe(
      "Project memory unavailable: local replica not initialised.",
    );
  });
});
