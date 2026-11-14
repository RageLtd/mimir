import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createOrgReplica,
  type OrgReplica,
} from "@mimir/plugin-core/store/org-replica";
import {
  orgMemoryToolNames,
  SEARCH_CROSS_PROJECT_MAX_DISTANCE,
  SEARCH_SAME_PROJECT_MAX_DISTANCE,
} from "@mimir/plugin-core/tools/org-memory";
import type { ToolContext } from "@opencode/plugin/promise/tool";
import { orgMemoryTools } from "./org-memory-tools";

let replica: OrgReplica;

beforeEach(() => {
  replica = createOrgReplica(":memory:");
});
afterEach(() => replica.close());

const noEmbedding = async (_text: string) => null;
const context: ToolContext = {
  // IDs are opaque protocol strings, restored at the serialization boundary.
  ...JSON.parse(
    '{"sessionID":"test-session","messageID":"test-message","agent":"mimir","id":"test-call"}',
  ),
  signal: new AbortController().signal,
  progress: async () => {},
};
const outputText = (result: { content: string }) => result.content;

describe("orgMemoryTools", () => {
  test("registers the complete project-memory and playbook surface", () => {
    const tools = orgMemoryTools(replica, noEmbedding);
    expect(Object.keys(tools).sort()).toEqual([...orgMemoryToolNames].sort());
    for (const definition of Object.values(tools)) {
      expect(definition.input.type).toBe("object");
      expect(definition.input.additionalProperties).toBe(false);
      expect(JSON.parse(JSON.stringify(definition.input))).toEqual(
        definition.input,
      );
    }
    expect(tools.project_memory_store.input.required).toEqual(["content"]);
    expect(tools.project_playbook_store.input.required).toEqual([
      "name",
      "trigger",
      "content",
    ]);
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

  describe("project_memory_search and the active project", () => {
    const ACTIVE_PROJECT = "project:active";
    const QUERY_VECTOR = [1, 0];
    const embedding = async (_text: string) => QUERY_VECTOR;
    // Between the two ceilings: near enough only for the active project.
    const BETWEEN_CEILINGS =
      (SEARCH_CROSS_PROJECT_MAX_DISTANCE + SEARCH_SAME_PROJECT_MAX_DISTANCE) /
      2;
    const vectorAt = (distance: number) => {
      const cos = 1 - distance;
      return [cos, Math.sqrt(1 - cos * cos)];
    };
    const searchIds = async (
      tools: ReturnType<typeof orgMemoryTools>,
      args: Record<string, unknown>,
    ) => {
      const result = await tools.project_memory_search.execute(
        { query: "deployment", ...args },
        context,
      );
      const parsed = JSON.parse(outputText(result)) as {
        results: Array<{ id: string }>;
      };
      return parsed.results.map((row) => row.id);
    };

    beforeEach(() => {
      replica.upsertMemory({
        id: "memory:active",
        content: "alpha note",
        project_id: ACTIVE_PROJECT,
        embedding: vectorAt(BETWEEN_CEILINGS),
      });
    });

    test("takes an optional project argument", () => {
      const { input } = orgMemoryTools(
        replica,
        embedding,
      ).project_memory_search;
      expect(input.properties).toHaveProperty("project");
      expect(input.required).toEqual(["query"]);
    });

    test("the resolver's project gets the active-project ceiling", async () => {
      const calls: Array<string | undefined> = [];
      const tools = orgMemoryTools(replica, embedding, async (project) => {
        calls.push(project);
        return ACTIVE_PROJECT;
      });

      expect(await searchIds(tools, {})).toEqual(["memory:active"]);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toBeUndefined();
    });

    test("a given project reaches the resolver as given", async () => {
      const calls: Array<string | undefined> = [];
      const tools = orgMemoryTools(replica, embedding, async (project) => {
        calls.push(project);
        return project;
      });

      expect(await searchIds(tools, { project: ACTIVE_PROJECT })).toEqual([
        "memory:active",
      ]);
      expect(calls).toEqual([ACTIVE_PROJECT]);
    });

    test("with no resolver the row is held to the cross-project ceiling", async () => {
      const tools = orgMemoryTools(replica, embedding);
      expect(await searchIds(tools, {})).toEqual([]);
    });
  });

  test("gracefully degrades when the replica cannot be opened", async () => {
    const tools = orgMemoryTools(null, noEmbedding);
    const result = await tools.project_memory_list.execute({}, context);
    expect(Object.keys(result)).toEqual(["content"]);
    expect(outputText(result)).toBe(
      "Project memory unavailable: local replica not initialised.",
    );
  });
  test("rejects malformed writes before changing the replica", async () => {
    const tools = orgMemoryTools(replica, noEmbedding);
    await expect(
      tools.project_memory_store.execute({ content: 42 }, context),
    ).rejects.toThrow("Invalid tool argument: content");
    await expect(
      tools.project_memory_delete.execute({}, context),
    ).rejects.toThrow("Invalid tool argument: id");
  });
});
