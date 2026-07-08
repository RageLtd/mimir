import { beforeEach, describe, expect, test } from "bun:test";
import {
  computeFreshness,
  cosineDistance,
  createOrgReplica,
  generateMemoryId,
  type OrgReplica,
} from "./org-replica";

let replica: OrgReplica;

beforeEach(() => {
  replica = createOrgReplica(":memory:");
});

describe("ids", () => {
  test("generateMemoryId produces server-style ids", () => {
    const id = generateMemoryId();
    expect(id).toMatch(/^memory:[a-z0-9]{20}$/);
    expect(generateMemoryId()).not.toBe(id);
  });
});

describe("store + get", () => {
  test("round-trips a memory with defaults", () => {
    const id = replica.storeMemory({ content: "the auth flow uses X25519" });
    const row = replica.getMemory(id);
    expect(row?.content).toBe("the auth flow uses X25519");
    expect(row?.type).toBe("fact");
    expect(row?.confidence).toBe(1.0);
    expect(row?.access_count).toBe(0);
    expect(row?.created_at).toBeTruthy();
  });

  test("getMemory returns null for unknown id", () => {
    expect(replica.getMemory("memory:doesnotexist")).toBeNull();
  });
});

describe("upsertMemory (import path)", () => {
  test("preserves the given id and created_at", () => {
    replica.upsertMemory({
      id: "memory:imported1",
      content: "imported fact",
      created_at: "2026-01-01 00:00:00",
      confidence: 0.8,
      access_count: 7,
    });
    const row = replica.getMemory("memory:imported1");
    expect(row?.created_at).toBe("2026-01-01 00:00:00");
    expect(row?.confidence).toBe(0.8);
    expect(row?.access_count).toBe(7);
  });

  test("is idempotent — re-upsert updates content, keeps one row", () => {
    replica.upsertMemory({ id: "memory:dup1", content: "v1" });
    replica.upsertMemory({ id: "memory:dup1", content: "v2" });
    expect(replica.countMemories()).toBe(1);
    expect(replica.getMemory("memory:dup1")?.content).toBe("v2");
    // FTS index followed the update
    const hits = replica.searchByText("v2");
    expect(hits.map((h) => h.id)).toContain("memory:dup1");
  });
});

describe("searchByText (FTS5)", () => {
  test("finds by content, higher score first", () => {
    replica.storeMemory({ content: "surreal database migration plan" });
    replica.storeMemory({ content: "migration of the surreal migration tooling migration" });
    replica.storeMemory({ content: "unrelated cooking recipe" });
    const hits = replica.searchByText("migration");
    expect(hits.length).toBe(2);
    const first = hits[0];
    const second = hits[1];
    expect(first && second && first.score >= second.score).toBe(true);
  });

  test("survives natural-language punctuation", () => {
    replica.storeMemory({ content: "the auth flow uses better-auth sessions" });
    expect(() => replica.searchByText("what's the auth flow?")).not.toThrow();
    const hits = replica.searchByText("what's the auth flow?");
    // conjunction of quoted terms — "what's" matches nothing, so no rows;
    // the point is no FTS syntax error
    expect(Array.isArray(hits)).toBe(true);
  });

  test("deleted rows leave the index", () => {
    const id = replica.storeMemory({ content: "ephemeral zanzibar fact" });
    replica.deleteMemory(id);
    expect(replica.searchByText("zanzibar")).toHaveLength(0);
  });
});

describe("searchByVector (exact cosine)", () => {
  test("orders by distance ascending", () => {
    replica.storeMemory({ content: "east", embedding: [1, 0, 0] });
    replica.storeMemory({ content: "north", embedding: [0, 1, 0] });
    replica.storeMemory({ content: "northeast", embedding: [0.7, 0.7, 0] });
    const hits = replica.searchByVector([1, 0, 0], 3);
    expect(hits.map((h) => h.content)).toEqual(["east", "northeast", "north"]);
    expect(hits[0]?.distance).toBeCloseTo(0, 5);
  });

  test("rows without embeddings are invisible to vector search", () => {
    replica.storeMemory({ content: "no vector yet" });
    replica.storeMemory({ content: "has vector", embedding: [1, 0] });
    const hits = replica.searchByVector([1, 0], 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.content).toBe("has vector");
  });
});

describe("findDuplicate / findNeighbors", () => {
  test("findDuplicate respects threshold", () => {
    replica.storeMemory({ content: "original", embedding: [1, 0, 0] });
    expect(replica.findDuplicate([1, 0.01, 0])?.content).toBe("original");
    expect(replica.findDuplicate([0, 1, 0])).toBeNull();
  });

  test("findNeighbors excludes the source id and far rows", () => {
    const a = replica.storeMemory({ content: "a", embedding: [1, 0, 0] });
    replica.storeMemory({ content: "b", embedding: [0.95, 0.1, 0] });
    replica.storeMemory({ content: "far", embedding: [0, 0, 1] });
    const neighbors = replica.findNeighbors([1, 0, 0], a, 5, 0.3);
    expect(neighbors.map((n) => n.content)).toEqual(["b"]);
  });
});

describe("relations", () => {
  test("graph hop finds both directions, excludes seeds, ranks by weight", () => {
    const a = replica.storeMemory({ content: "seed" });
    const b = replica.storeMemory({ content: "outgoing" });
    const c = replica.storeMemory({ content: "incoming" });
    replica.createRelation(a, b, 0.9);
    replica.createRelation(c, a, 0.5);
    const related = replica.getRelatedMemories([a]);
    expect(related.map((r) => r.content)).toEqual(["outgoing", "incoming"]);
  });

  test("createRelation upserts weight", () => {
    const a = replica.storeMemory({ content: "a" });
    const b = replica.storeMemory({ content: "b" });
    replica.createRelation(a, b, 0.2);
    replica.createRelation(a, b, 0.8);
    const related = replica.getRelatedMemories([a]);
    expect(related[0]?.weight).toBe(0.8);
  });

  test("updateMemory severs relations", () => {
    const a = replica.storeMemory({ content: "a" });
    const b = replica.storeMemory({ content: "b" });
    replica.createRelation(a, b, 0.9);
    expect(replica.updateMemory(a, "a v2")).toBe(true);
    expect(replica.getRelatedMemories([a])).toHaveLength(0);
    expect(replica.getMemory(a)?.content).toBe("a v2");
  });

  test("deleteMemory cascades relations", () => {
    const a = replica.storeMemory({ content: "a" });
    const b = replica.storeMemory({ content: "b" });
    replica.createRelation(a, b, 0.9);
    expect(replica.deleteMemory(b)).toBe(true);
    expect(replica.getRelatedMemories([a])).toHaveLength(0);
  });
});

describe("touch + listings", () => {
  test("touchMemories bumps access_count and last_accessed", () => {
    const id = replica.storeMemory({ content: "touched" });
    replica.touchMemories([id]);
    replica.touchMemories([id]);
    const row = replica.getMemory(id);
    expect(row?.access_count).toBe(2);
    expect(row?.last_accessed).toBeTruthy();
  });

  test("getLastSummaries filters by type, newest first", () => {
    replica.upsertMemory({
      id: "memory:sum1",
      content: "old summary",
      type: "summary",
      created_at: "2026-01-01 00:00:00",
    });
    replica.upsertMemory({
      id: "memory:sum2",
      content: "new summary",
      type: "summary",
      created_at: "2026-06-01 00:00:00",
    });
    replica.storeMemory({ content: "a fact" });
    const summaries = replica.getLastSummaries(5);
    expect(summaries.map((s) => s.content)).toEqual([
      "new summary",
      "old summary",
    ]);
  });

  test("listPlaybooks returns only named playbooks", () => {
    replica.storeMemory({
      content: "playbook body",
      type: "playbook",
      name: "Deploy on Railway",
      trigger: "use when deploying",
    });
    replica.storeMemory({ content: "a fact" });
    const playbooks = replica.listPlaybooks();
    expect(playbooks).toHaveLength(1);
    expect(playbooks[0]?.name).toBe("Deploy on Railway");
  });
});

describe("embedding backfill seam (MIM-85)", () => {
  test("listUnembedded + setEmbedding round-trip", () => {
    const id = replica.storeMemory({ content: "needs vector" });
    replica.storeMemory({ content: "has vector", embedding: [1, 0] });
    const pending = replica.listUnembedded();
    expect(pending.map((p) => p.id)).toEqual([id]);
    expect(replica.setEmbedding(id, [0, 1])).toBe(true);
    expect(replica.listUnembedded()).toHaveLength(0);
    expect(replica.searchByVector([0, 1], 1)[0]?.id).toBe(id);
  });
});

describe("pure helpers", () => {
  test("cosineDistance: identical → 0, orthogonal → 1", () => {
    const a = Float32Array.from([1, 0]);
    const b = Float32Array.from([0, 1]);
    expect(cosineDistance(a, a)).toBeCloseTo(0, 6);
    expect(cosineDistance(a, b)).toBeCloseTo(1, 6);
  });

  test("computeFreshness: unset → 1, ancient → floor 0.1", () => {
    expect(computeFreshness(null)).toBe(1.0);
    expect(computeFreshness("2020-01-01T00:00:00Z")).toBe(0.1);
    const recent = computeFreshness(new Date().toISOString());
    expect(recent).toBeGreaterThan(0.95);
  });
});
