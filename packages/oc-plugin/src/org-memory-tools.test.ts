import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createOrgReplica,
  type OrgReplica,
} from "@mimir/plugin-core/store/org-replica";
import { orgMemoryToolNames } from "@mimir/plugin-core/tools/org-memory";
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
