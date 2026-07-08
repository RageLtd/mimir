import { beforeEach, describe, expect, test } from "bun:test";
import { createOrgReplica, type OrgReplica } from "../store/org-replica";
import { executeOrgMemoryTool } from "./org-memory";
import { orgMemoryToolDefs, orgMemoryToolNames } from "./org-memory-defs";

let replica: OrgReplica;

beforeEach(() => {
  replica = createOrgReplica(":memory:");
});

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await executeOrgMemoryTool(replica, name, args);
  return JSON.parse(result.content) as Record<string, unknown>;
};

describe("tool definitions", () => {
  test("cover the full server tool surface", () => {
    expect([...orgMemoryToolNames].sort()).toEqual([
      "project_memory_delete",
      "project_memory_list",
      "project_memory_search",
      "project_memory_store",
      "project_memory_update",
      "project_playbook_delete",
      "project_playbook_list",
      "project_playbook_load",
      "project_playbook_store",
      "project_playbook_update",
    ]);
    for (const def of orgMemoryToolDefs) {
      expect(def.function.description?.length).toBeGreaterThan(20);
    }
  });
});

describe("project_memory lifecycle (no embedder — pre-MIM-85)", () => {
  test("store → search → update → delete round-trip", async () => {
    const stored = await call("project_memory_store", {
      content: "the sync seam owns all crypto",
    });
    expect(stored.stored).toBe(true);
    const id = stored.id as string;
    expect(id).toMatch(/^memory:/);

    const search = await call("project_memory_search", {
      query: "crypto seam",
    });
    const results = search.results as Array<{ id: string; content: string }>;
    expect(results.map((r) => r.id)).toContain(id);

    const updated = await call("project_memory_update", {
      id,
      content: "the sync seam owns all crypto, nothing else touches ciphers",
    });
    expect(updated.updated).toBe(true);

    const deleted = await call("project_memory_delete", { id });
    expect(deleted.deleted).toBe(true);
    const after = await call("project_memory_search", { query: "crypto" });
    expect((after.results as unknown[]).length).toBe(0);
  });

  test("list returns recency-ordered rows with server field shape", async () => {
    await call("project_memory_store", { content: "first fact" });
    const list = await call("project_memory_list", {});
    const memories = list.memories as Array<Record<string, unknown>>;
    expect(memories).toHaveLength(1);
    expect(Object.keys(memories[0] ?? {}).sort()).toEqual([
      "access_count",
      "content",
      "created_at",
      "id",
      "project_id",
    ]);
  });

  test("update/delete on unknown ids report errors, not throws", async () => {
    const updated = await call("project_memory_update", {
      id: "memory:nope",
      content: "x",
    });
    expect(updated.updated).toBe(false);
    const deleted = await call("project_memory_delete", { id: "memory:nope" });
    expect(deleted.deleted).toBe(false);
  });
});

describe("project_memory with embedder", () => {
  test("dedup blocks a near-identical store", async () => {
    const embedder = async (_text: string) => [1, 0, 0];
    const first = await executeOrgMemoryTool(
      replica,
      "project_memory_store",
      { content: "original fact" },
      embedder,
    );
    expect(JSON.parse(first.content).stored).toBe(true);
    const second = await executeOrgMemoryTool(
      replica,
      "project_memory_store",
      { content: "original fact restated" },
      embedder,
    );
    const parsed = JSON.parse(second.content);
    expect(parsed.stored).toBe(false);
    expect(parsed.message).toBe("Similar memory exists");
  });
});

describe("project_playbook lifecycle", () => {
  test("store requires name+trigger+content; then list/load/update/delete", async () => {
    const missing = await call("project_playbook_store", { name: "X" });
    expect(missing.stored).toBe(false);

    const stored = await call("project_playbook_store", {
      name: "Deploy on Railway",
      trigger: "use when deploying to Railway",
      content: "1. railway up\n2. verify /health",
    });
    expect(stored.stored).toBe(true);

    const list = await call("project_playbook_list");
    const playbooks = list.playbooks as Array<{ name: string }>;
    expect(playbooks.map((p) => p.name)).toEqual(["Deploy on Railway"]);

    const loaded = await call("project_playbook_load", {
      name: "Deploy on Railway",
    });
    expect(loaded.found).toBe(true);
    expect(loaded.content).toContain("railway up");

    const updated = await call("project_playbook_update", {
      name: "Deploy on Railway",
      trigger: "use when deploying or redeploying to Railway",
    });
    expect(updated.updated).toBe(true);
    const reloaded = await call("project_playbook_load", {
      name: "Deploy on Railway",
    });
    expect(reloaded.trigger).toContain("redeploying");
    // Body survives a trigger-only update
    expect(reloaded.content).toContain("railway up");

    const deleted = await call("project_playbook_delete", {
      name: "Deploy on Railway",
    });
    expect(deleted.deleted).toBe(true);
    const emptyList = await call("project_playbook_list");
    expect((emptyList.playbooks as unknown[]).length).toBe(0);
  });

  test("load/update/delete without selector report errors", async () => {
    const load = await call("project_playbook_load");
    expect(load.found).toBe(false);
    const update = await call("project_playbook_update", { content: "x" });
    expect(update.updated).toBe(false);
    const del = await call("project_playbook_delete");
    expect(del.deleted).toBe(false);
  });
});

describe("unknown tool", () => {
  test("flags isError without JSON body", async () => {
    const result = await executeOrgMemoryTool(replica, "nonsense_tool", {});
    expect(result.isError).toBe(true);
  });
});
