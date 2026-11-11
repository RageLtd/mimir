import { beforeEach, describe, expect, test } from "bun:test";
import { createOrgReplica, type OrgReplica } from "../store/org-replica";
import {
  buildPlaybookContext,
  CROSS_PROJECT_MAX_DISTANCE,
  retrieveLocalContext,
  retrieveMemoryList,
  SAME_PROJECT_MAX_DISTANCE,
} from "./retrieve";

let replica: OrgReplica;

beforeEach(() => {
  replica = createOrgReplica(":memory:");
});

/** Deterministic fake embedder: known texts map to fixed vectors. */
const fakeEmbedder = (table: Record<string, number[]>) => {
  return async (text: string) => table[text] ?? null;
};

const QUERY = "why does the gateway time out";
const embedQuery = fakeEmbedder({ [QUERY]: [1, 0, 0] });

/** A unit vector at exactly this cosine distance from the query vector. */
const at = (distance: number) => {
  const cos = 1 - distance;
  return [cos, Math.sqrt(1 - cos * cos), 0];
};

const NEAR = 0.2;
/** Between the two cutoffs: admitted only for the active project. */
const MIDDLE = (CROSS_PROJECT_MAX_DISTANCE + SAME_PROJECT_MAX_DISTANCE) / 2;
const FAR = 0.6;

const store = (
  id: string,
  distance: number,
  over: {
    content?: string;
    project_id?: string;
    type?: "fact" | "summary" | "playbook";
    created_at?: string;
    confidence?: number;
  } = {},
) =>
  replica.upsertMemory({
    id,
    content: over.content ?? `content of ${id}`,
    embedding: at(distance),
    created_at: over.created_at ?? "2026-10-18 09:30:00",
    ...(over.project_id ? { project_id: over.project_id } : {}),
    ...(over.type ? { type: over.type } : {}),
    ...(over.confidence !== undefined ? { confidence: over.confidence } : {}),
  });

describe("retrieveMemoryList — the distance gate", () => {
  test("a near row is admitted, a far one is not", async () => {
    store("memory:near", NEAR);
    store("memory:far", FAR);
    const memories = await retrieveMemoryList(replica, QUERY, { embedQuery });
    expect(memories).toEqual(["[2026-10-18] content of memory:near"]);
  });

  test("nothing near enough is null, not a weak match", async () => {
    store("memory:far", FAR);
    expect(await retrieveMemoryList(replica, QUERY, { embedQuery })).toBeNull();
  });

  test("the active project's rows get a wider cutoff", async () => {
    store("memory:ours", MIDDLE, { project_id: "project:a" });
    store("memory:theirs", MIDDLE, { project_id: "project:b" });
    store("memory:unscoped", MIDDLE);
    const memories = await retrieveMemoryList(replica, QUERY, {
      embedQuery,
      projectId: "project:a",
    });
    expect(memories).toEqual(["[2026-10-18] content of memory:ours"]);
  });

  test("a near row from another project is admitted and says where it is from", async () => {
    store("memory:theirs", NEAR, { project_id: "project:b" });
    const named = await retrieveMemoryList(replica, QUERY, {
      embedQuery,
      projectId: "project:a",
      projectNames: { "project:b": "data-services" },
    });
    expect(named).toEqual([
      "[2026-10-18, from data-services] content of memory:theirs",
    ]);

    const unnamed = await retrieveMemoryList(replica, QUERY, {
      embedQuery,
      projectId: "project:a",
    });
    expect(unnamed).toEqual([
      "[2026-10-18, from another project] content of memory:theirs",
    ]);
  });

  test("nearest first, capped at topK", async () => {
    store("memory:second", 0.25);
    store("memory:first", 0.1);
    store("memory:third", 0.3);
    const memories = await retrieveMemoryList(replica, QUERY, {
      embedQuery,
      topK: 2,
    });
    expect(memories).toEqual([
      "[2026-10-18] content of memory:first",
      "[2026-10-18] content of memory:second",
    ]);
  });

  test("the project allowance ranks as well as admits", async () => {
    // Same distance: the active project's row has more room under its
    // cutoff, so it leads.
    store("memory:theirs", 0.3, { project_id: "project:b" });
    store("memory:ours", 0.3, { project_id: "project:a" });
    const memories = await retrieveMemoryList(replica, QUERY, {
      embedQuery,
      projectId: "project:a",
      topK: 1,
    });
    expect(memories).toEqual(["[2026-10-18] content of memory:ours"]);
  });

  test("a demoted row ranks below an equally near one", async () => {
    store("memory:demoted", 0.2, { confidence: 0.3 });
    store("memory:trusted", 0.2);
    const memories = await retrieveMemoryList(replica, QUERY, {
      embedQuery,
      topK: 1,
    });
    expect(memories).toEqual(["[2026-10-18] content of memory:trusted"]);
  });

  test("playbooks and summaries are not facts", async () => {
    store("memory:playbook", NEAR, { type: "playbook" });
    store("memory:summary", NEAR, { type: "summary" });
    expect(await retrieveMemoryList(replica, QUERY, { embedQuery })).toBeNull();
  });

  test("skipped ids are not returned again", async () => {
    store("memory:seen", 0.1);
    store("memory:new", 0.2);
    const memories = await retrieveMemoryList(replica, QUERY, {
      embedQuery,
      exclude: new Set(["memory:seen"]),
    });
    expect(memories).toEqual(["[2026-10-18] content of memory:new"]);
  });

  test("retrieval does not count as access", async () => {
    store("memory:near", NEAR);
    await retrieveMemoryList(replica, QUERY, { embedQuery });
    const row = replica.getMemory("memory:near");
    expect(row?.access_count).toBe(0);
    expect(row?.last_accessed).toBeNull();
  });

  test("a graph neighbour of an admitted row still has to pass the gate", async () => {
    store("memory:near", NEAR);
    store("memory:neighbour", FAR, { content: "neighbouring detail" });
    replica.createRelation("memory:near", "memory:neighbour", 0.9);
    const memories = await retrieveMemoryList(replica, QUERY, { embedQuery });
    expect(memories).toEqual(["[2026-10-18] content of memory:near"]);
  });

  test("the cutoffs sit where they say", async () => {
    const EDGE = 0.01;
    store("memory:in", CROSS_PROJECT_MAX_DISTANCE - EDGE);
    store("memory:out", CROSS_PROJECT_MAX_DISTANCE + EDGE);
    store("memory:ours-in", SAME_PROJECT_MAX_DISTANCE - EDGE, {
      project_id: "project:a",
    });
    store("memory:ours-out", SAME_PROJECT_MAX_DISTANCE + EDGE, {
      project_id: "project:a",
    });
    const memories = await retrieveMemoryList(replica, QUERY, {
      embedQuery,
      projectId: "project:a",
    });
    expect(memories?.sort()).toEqual([
      "[2026-10-18] content of memory:in",
      "[2026-10-18] content of memory:ours-in",
    ]);
  });

  test("with no active project every row takes the narrower cutoff, unlabelled", async () => {
    store("memory:middle", MIDDLE, { project_id: "project:b" });
    store("memory:near", NEAR, { project_id: "project:b" });
    const memories = await retrieveMemoryList(replica, QUERY, {
      embedQuery,
      projectNames: { "project:b": "data-services" },
    });
    expect(memories).toEqual(["[2026-10-18] content of memory:near"]);
  });
});

describe("retrieveMemoryList — no vector, no retrieval", () => {
  test("a text match alone injects nothing", async () => {
    replica.storeMemory({ content: "the gateway time out was a 30s default" });
    expect(await retrieveMemoryList(replica, QUERY)).toBeNull();
    expect(
      await retrieveMemoryList(replica, QUERY, {
        embedQuery: async () => null,
      }),
    ).toBeNull();
  });

  test("an empty query is null", async () => {
    store("memory:near", NEAR);
    expect(await retrieveMemoryList(replica, "   ", { embedQuery })).toBeNull();
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
    expect(block).toContain(
      "- Deploy on Railway — use when deploying to Railway",
    );
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

describe("retrieveLocalContext", () => {
  test("injection does not count as access", async () => {
    store("memory:fact", NEAR);
    store("memory:sum", NEAR, { type: "summary" });
    const result = await retrieveLocalContext(replica, QUERY, { embedQuery });
    expect(result.injectedIds.length).toBe(2);
    for (const id of result.injectedIds) {
      const row = replica.getMemory(id);
      expect(row?.access_count).toBe(0);
      expect(row?.last_accessed).toBeNull();
    }
  });

  test("a summary spends the same budget the facts do", async () => {
    store("memory:sum", 0.1, { type: "summary", content: "s".repeat(80) });
    store("memory:fact", 0.2, { content: "f".repeat(40) });
    const result = await retrieveLocalContext(replica, QUERY, {
      embedQuery,
      maxChars: 100,
    });
    expect(result.injectedIds).toEqual(["memory:sum"]);
  });

  test("an empty replica injects nothing", async () => {
    const result = await retrieveLocalContext(replica, QUERY, { embedQuery });
    expect(result).toEqual({
      contextBlock: "",
      memoryCount: 0,
      summaryCount: 0,
      injectedIds: [],
      embedderUnavailable: false,
    });
  });

  test("a prompt nothing matches injects nothing", async () => {
    store("memory:far", FAR);
    store("memory:far-summary", FAR, { type: "summary" });
    const result = await retrieveLocalContext(replica, QUERY, { embedQuery });
    expect(result.contextBlock).toBe("");
    expect(result.injectedIds).toEqual([]);
  });

  test("wraps the matching summary, memories and playbooks", async () => {
    store("memory:fact", NEAR, { content: "gateway timeout was 30s" });
    store("memory:sum", NEAR, {
      type: "summary",
      content: "we raised the gateway timeout",
      created_at: "2026-11-10 03:33:24",
    });
    replica.storeMemory({
      content: "playbook body",
      type: "playbook",
      name: "Import",
      trigger: "use when importing",
    });

    const result = await retrieveLocalContext(replica, QUERY, { embedQuery });
    expect(result.contextBlock).toStartWith("<retrieved_context>\n");
    expect(result.contextBlock).toEndWith("\n</retrieved_context>");
    expect(result.contextBlock).toContain(
      "<summaries>\n[Summary 1, 2026-11-10]\nwe raised the gateway timeout\n</summaries>",
    );
    expect(result.contextBlock).toContain(
      "<memories>\n- [2026-10-18] gateway timeout was 30s\n</memories>",
    );
    expect(result.contextBlock).toContain("<playbooks>");
    expect(result.memoryCount).toBe(1);
    expect(result.summaryCount).toBe(1);
    expect(result.injectedIds.sort()).toEqual(["memory:fact", "memory:sum"]);
  });

  test("another project's summary is not injected for an unrelated prompt", async () => {
    // The newest summary in the replica, from another project, far away.
    store("memory:their-summary", FAR, {
      type: "summary",
      project_id: "project:b",
      created_at: "2026-11-10 12:00:00",
    });
    const result = await retrieveLocalContext(replica, QUERY, {
      embedQuery,
      projectId: "project:a",
    });
    expect(result.contextBlock).toBe("");
    expect(result.summaryCount).toBe(0);
  });

  test("a matching summary from another project says where it is from", async () => {
    store("memory:their-summary", NEAR, {
      type: "summary",
      project_id: "project:b",
      content: "fixed the same timeout there",
    });
    const result = await retrieveLocalContext(replica, QUERY, {
      embedQuery,
      projectId: "project:a",
      projectNames: { "project:b": "data-services" },
    });
    expect(result.contextBlock).toContain(
      "[Summary 1, 2026-10-18, from data-services]\nfixed the same timeout there",
    );
  });

  test("at most one summary per prompt, the best match", async () => {
    store("memory:sum-near", 0.1, { type: "summary" });
    store("memory:sum-next", 0.2, { type: "summary" });
    const result = await retrieveLocalContext(replica, QUERY, { embedQuery });
    expect(result.summaryCount).toBe(1);
    expect(result.injectedIds).toEqual(["memory:sum-near"]);
  });

  test("summaryCount raises the cap for boot-sized retrievals", async () => {
    store("memory:sum-near", 0.1, { type: "summary" });
    store("memory:sum-next", 0.2, { type: "summary" });
    const result = await retrieveLocalContext(replica, QUERY, {
      embedQuery,
      summaryCount: 3,
    });
    expect(result.summaryCount).toBe(2);
  });

  test("rows that do not fit the character budget are left out", async () => {
    store("memory:big", 0.1, { content: "x".repeat(300) });
    store("memory:small", 0.2, { content: "small fact" });
    const result = await retrieveLocalContext(replica, QUERY, {
      embedQuery,
      maxChars: 100,
    });
    expect(result.injectedIds).toEqual(["memory:small"]);
    expect(result.memoryCount).toBe(1);
    expect(result.contextBlock).not.toContain("xxx");
  });

  test("skipped ids are not injected again", async () => {
    store("memory:fact", NEAR);
    store("memory:sum", NEAR, { type: "summary" });
    const first = await retrieveLocalContext(replica, QUERY, { embedQuery });
    const second = await retrieveLocalContext(replica, QUERY, {
      embedQuery,
      exclude: new Set(first.injectedIds),
    });
    expect(first.injectedIds.length).toBe(2);
    expect(second.contextBlock).toBe("");
    expect(second.injectedIds).toEqual([]);
  });

  test("without a query vector nothing is retrieved, and it says so", async () => {
    replica.storeMemory({ content: "the gateway time out was a 30s default" });
    store("memory:near", NEAR);
    const result = await retrieveLocalContext(replica, QUERY, {
      embedQuery: async () => null,
    });
    expect(result.memoryCount).toBe(0);
    expect(result.summaryCount).toBe(0);
    expect(result.injectedIds).toEqual([]);
    expect(result.embedderUnavailable).toBe(true);
  });
});
