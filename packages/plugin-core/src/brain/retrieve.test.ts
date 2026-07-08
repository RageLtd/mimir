import { beforeEach, describe, expect, test } from "bun:test";
import { createOrgReplica, type OrgReplica } from "../store/org-replica";
import {
  buildPlaybookContext,
  retrieveLocalContext,
  retrieveMemoryList,
  scoreRetrievalCandidate,
} from "./retrieve";

let replica: OrgReplica;

beforeEach(() => {
  replica = createOrgReplica(":memory:");
});

/** Deterministic fake embedder: known texts map to fixed vectors. */
const fakeEmbedder = (table: Record<string, number[]>) => {
  return async (text: string) => table[text] ?? null;
};

describe("scoreRetrievalCandidate (parity with goldfish/memory.ts)", () => {
  test("confidence multiplies, project bonus adds outside the multiply", () => {
    const base = scoreRetrievalCandidate({
      combinedScore: 0.7,
      freshness: 1,
      confidence: 1,
      projectBonus: 0,
    });
    const demoted = scoreRetrievalCandidate({
      combinedScore: 0.7,
      freshness: 1,
      confidence: 0.5,
      projectBonus: 0,
    });
    const bonused = scoreRetrievalCandidate({
      combinedScore: 0.7,
      freshness: 1,
      confidence: 1,
      projectBonus: 0.02,
    });
    expect(demoted).toBeCloseTo(base / 2, 6);
    expect(bonused).toBeCloseTo(base + 0.02, 6);
  });

  test("zero combined score falls back to neutral 0.5", () => {
    expect(
      scoreRetrievalCandidate({
        combinedScore: 0,
        freshness: 1,
        confidence: 1,
        projectBonus: 0,
      }),
    ).toBe(0.5);
  });
});

describe("retrieveMemoryList — FTS-only degradation (pre-MIM-85)", () => {
  test("retrieves by text match without any embedder", async () => {
    replica.storeMemory({ content: "the surreal bridge uses HS256 JWTs" });
    replica.storeMemory({ content: "biome runs on every commit" });
    const memories = await retrieveMemoryList(replica, "surreal bridge JWT", {
      topK: 3,
    });
    expect(memories).not.toBeNull();
    expect(memories?.[0]).toContain("surreal bridge");
  });

  test("returns null for empty query and empty store", async () => {
    expect(await retrieveMemoryList(replica, "   ")).toBeNull();
    expect(await retrieveMemoryList(replica, "anything")).toBeNull();
  });

  test("excludes playbooks from the fact budget", async () => {
    replica.storeMemory({
      content: "deploy procedure body mentioning kubernetes",
      type: "playbook",
      name: "Deploy",
      trigger: "use when deploying kubernetes",
    });
    expect(await retrieveMemoryList(replica, "kubernetes")).toBeNull();
  });

  test("touches retrieved memories", async () => {
    const id = replica.storeMemory({ content: "touchable zanzibar fact" });
    await retrieveMemoryList(replica, "zanzibar");
    expect(replica.getMemory(id)?.access_count).toBe(1);
  });

  test("includeRelated folds in graph neighbours with prefix", async () => {
    const a = replica.storeMemory({ content: "zanzibar main fact" });
    const b = replica.storeMemory({ content: "neighbouring detail" });
    replica.createRelation(a, b, 0.9);
    const memories = await retrieveMemoryList(replica, "zanzibar", {
      includeRelated: true,
    });
    expect(memories).toContain("[related] neighbouring detail");
  });
});

describe("retrieveMemoryList — vector leg", () => {
  test("vector-matched memory outranks weak text match", async () => {
    replica.storeMemory({
      content: "vectors are semantically close here",
      embedding: [1, 0, 0],
    });
    replica.storeMemory({ content: "query mentions semantically once" });
    const memories = await retrieveMemoryList(replica, "semantically", {
      embedQuery: fakeEmbedder({ semantically: [1, 0.05, 0] }),
      topK: 2,
    });
    expect(memories?.[0]).toContain("vectors are semantically close");
  });

  test("project bonus breaks true ties (tiebreaker, not override)", async () => {
    // Same token count, same single matched term → identical BM25 →
    // only the project bonus separates them. A genuinely better
    // cross-project match must still win (server spec: tiebreaker).
    replica.storeMemory({
      content: "zanzibar fact alpha",
      project_id: "proj-a",
    });
    replica.storeMemory({ content: "zanzibar fact beta" });
    const memories = await retrieveMemoryList(replica, "zanzibar", {
      projectId: "proj-a",
      topK: 2,
    });
    expect(memories?.[0]).toBe("zanzibar fact alpha");
  });
});

describe("buildPlaybookContext", () => {
  test("index always surfaces structured in-scope playbooks", async () => {
    replica.storeMemory({
      content: "1. do the thing\n2. verify",
      type: "playbook",
      name: "Deploy on Railway",
      trigger: "use when deploying to Railway",
    });
    const block = await buildPlaybookContext(replica, "unrelated query");
    expect(block).toContain("Available playbooks");
    expect(block).toContain("- Deploy on Railway — use when deploying to Railway");
    expect(block).not.toContain("Relevant to the current task");
  });

  test("unstructured playbooks sit out; other-project playbooks drop", async () => {
    replica.storeMemory({ content: "nameless body", type: "playbook" });
    replica.storeMemory({
      content: "other project procedure",
      type: "playbook",
      name: "Other",
      trigger: "elsewhere",
      project_id: "proj-b",
    });
    const block = await buildPlaybookContext(replica, "query", {
      projectId: "proj-a",
    });
    expect(block).toBeNull();
  });

  test("ambient body appears when trigger embedding matches", async () => {
    replica.storeMemory({
      content: "STEP ONE: docker build",
      type: "playbook",
      name: "Deploy",
      trigger: "use when deploying",
      embedding: [1, 0, 0],
    });
    const block = await buildPlaybookContext(replica, "deploy the app", {
      embedQuery: fakeEmbedder({ "deploy the app": [1, 0.1, 0] }),
    });
    expect(block).toContain("Relevant to the current task");
    expect(block).toContain("STEP ONE: docker build");
  });
});

describe("retrieveLocalContext — /v1/context/retrieve parity", () => {
  test("empty replica → empty contextBlock contract", async () => {
    const result = await retrieveLocalContext(replica, "anything");
    expect(result).toEqual({
      contextBlock: "",
      memoryCount: 0,
      summaryCount: 0,
    });
  });

  test("wraps memories + summaries + playbooks in <retrieved_context>", async () => {
    replica.storeMemory({ content: "zanzibar memory fact" });
    replica.upsertMemory({
      id: "memory:sum1",
      content: "we built the replica store",
      type: "summary",
    });
    replica.storeMemory({
      content: "playbook body",
      type: "playbook",
      name: "Import",
      trigger: "use when importing",
    });

    const result = await retrieveLocalContext(replica, "zanzibar");
    expect(result.contextBlock).toStartWith("<retrieved_context>\n");
    expect(result.contextBlock).toEndWith("\n</retrieved_context>");
    expect(result.contextBlock).toContain(
      "<summaries>\n[Summary 1]\nwe built the replica store\n</summaries>",
    );
    expect(result.contextBlock).toContain(
      "<memories>\n- zanzibar memory fact\n</memories>",
    );
    expect(result.contextBlock).toContain("<playbooks>");
    expect(result.memoryCount).toBe(1);
    expect(result.summaryCount).toBe(1);
  });

  test("summaries alone still produce a block (no memory match)", async () => {
    replica.upsertMemory({
      id: "memory:sum2",
      content: "session summary only",
      type: "summary",
    });
    const result = await retrieveLocalContext(replica, "nomatchword");
    expect(result.contextBlock).toContain("<summaries>");
    expect(result.contextBlock).not.toContain("<memories>");
    expect(result.memoryCount).toBe(0);
    expect(result.summaryCount).toBe(1);
  });
});
