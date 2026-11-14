import { beforeEach, describe, expect, test } from "bun:test";
import type { EmbedQuery } from "../brain/retrieve";
import {
  createOrgReplica,
  type MemoryType,
  type OrgReplica,
} from "../store/org-replica";
import {
  executeOrgMemoryTool,
  orgMemoryToolDefs,
  SEARCH_CROSS_PROJECT_MAX_DISTANCE,
  SEARCH_SAME_PROJECT_MAX_DISTANCE,
  TEXT_HIT_EQUIVALENT_DISTANCE,
} from "./org-memory";

const SEARCH = "project_memory_search";
const ACTIVE_PROJECT = "project:active";
const OTHER_PROJECT = "project:other";
const NO_MEMORIES = "No memories found";
const DEFAULT_LIMIT = 10;

// Distances placed with clear margin around the ceilings.
const MARGIN = 0.05;
const FAR = SEARCH_SAME_PROJECT_MAX_DISTANCE + 4 * MARGIN;
const BETWEEN_CEILINGS =
  (SEARCH_CROSS_PROJECT_MAX_DISTANCE + SEARCH_SAME_PROJECT_MAX_DISTANCE) / 2;
const JUST_UNDER_CROSS = SEARCH_CROSS_PROJECT_MAX_DISTANCE - MARGIN;
const NEARER_THAN_TEXT = TEXT_HIT_EQUIVALENT_DISTANCE - 2 * MARGIN;
const NEAR = NEARER_THAN_TEXT;

/** The query vector; every row's embedding is a unit vector at a chosen
 *  angle from it, so its cosine distance is exactly `distance`. */
const QUERY_VECTOR = [1, 0];
const vectorAt = (distance: number) => {
  const cos = 1 - distance;
  return [cos, Math.sqrt(1 - cos * cos)];
};
const embedQuery = async (_text: string) => QUERY_VECTOR;

type SearchRow = {
  id: string;
  content: string;
  distance: number | null;
  project_id: string | null;
  created_at: string;
};
type SearchResult = { results: SearchRow[]; message: string | null };

let replica: OrgReplica;

beforeEach(() => {
  replica = createOrgReplica(":memory:");
});

const put = (row: {
  id: string;
  content: string;
  distance: number;
  project?: string;
  confidence?: number;
  type?: MemoryType;
}) =>
  replica.upsertMemory({
    id: row.id,
    content: row.content,
    project_id: row.project,
    confidence: row.confidence,
    type: row.type,
    name: row.type === "playbook" ? row.id : undefined,
    trigger: row.type === "playbook" ? row.content : undefined,
    embedding: vectorAt(row.distance),
  });

const activeResolver = async (_project: string | undefined) => ACTIVE_PROJECT;

const search = async (
  args: Record<string, unknown>,
  resolveProjectId: (
    project: string | undefined,
  ) => Promise<string | undefined> = activeResolver,
) => {
  const result = await executeOrgMemoryTool(
    replica,
    SEARCH,
    args,
    embedQuery,
    resolveProjectId,
  );
  return JSON.parse(result.content) as SearchResult;
};

/** Like `search`, but the test chooses the embedder (or none at all). */
const searchWithEmbedder = async (
  args: Record<string, unknown>,
  embedder: EmbedQuery | undefined,
) => {
  const result = await executeOrgMemoryTool(
    replica,
    SEARCH,
    args,
    embedder,
    activeResolver,
  );
  return JSON.parse(result.content) as SearchResult;
};

const ids = (result: SearchResult) => result.results.map((r) => r.id);

describe("project_memory_search tool definition", () => {
  test("takes an optional project string; query stays the only required", () => {
    const def = orgMemoryToolDefs.find((d) => d.function.name === SEARCH);
    const parameters = def?.function.parameters;
    expect(parameters).toMatchObject({
      properties: { project: { type: "string" } },
    });
    expect(parameters?.required).toEqual(["query"]);
  });
});

describe("project_memory_search distance gate", () => {
  test("a far row is not returned; nothing near means no memories", async () => {
    put({ id: "memory:far", content: "unrelated note", distance: FAR });
    const result = await search({ query: "deployment" });
    expect(result.results).toEqual([]);
    expect(result.message).toBe(NO_MEMORIES);
  });

  test("a row between the ceilings is returned only for the active project", async () => {
    put({
      id: "memory:active",
      content: "alpha note",
      distance: BETWEEN_CEILINGS,
      project: ACTIVE_PROJECT,
    });
    put({
      id: "memory:other",
      content: "beta note",
      distance: BETWEEN_CEILINGS,
      project: OTHER_PROJECT,
    });
    put({
      id: "memory:unscoped",
      content: "gamma note",
      distance: BETWEEN_CEILINGS,
    });
    const result = await search({ query: "deployment" });
    expect(ids(result)).toEqual(["memory:active"]);
  });

  test("each result carries id, content, distance, project_id, created_at", async () => {
    put({
      id: "memory:near",
      content: "near note",
      distance: NEAR,
      project: ACTIVE_PROJECT,
    });
    const result = await search({ query: "deployment" });
    const [row] = result.results;
    expect(Object.keys(row ?? {}).sort()).toEqual([
      "content",
      "created_at",
      "distance",
      "id",
      "project_id",
    ]);
    expect(row?.distance).toBeCloseTo(NEAR, 5);
    expect(row?.project_id).toBe(ACTIVE_PROJECT);
    expect(typeof row?.created_at).toBe("string");
  });
});

describe("project_memory_search ranking", () => {
  test("at equal distance the active project's row comes first", async () => {
    put({
      id: "memory:other",
      content: "beta note",
      distance: JUST_UNDER_CROSS,
      project: OTHER_PROJECT,
    });
    put({
      id: "memory:active",
      content: "alpha note",
      distance: JUST_UNDER_CROSS,
      project: ACTIVE_PROJECT,
    });
    const result = await search({ query: "deployment" });
    expect(ids(result)).toEqual(["memory:active", "memory:other"]);
  });

  test("a nearer row beats a farther one", async () => {
    put({ id: "memory:farther", content: "beta", distance: JUST_UNDER_CROSS });
    put({ id: "memory:nearer", content: "alpha", distance: NEAR });
    const result = await search({ query: "deployment" });
    expect(ids(result)).toEqual(["memory:nearer", "memory:farther"]);
  });

  test("at equal distance higher confidence beats lower", async () => {
    put({
      id: "memory:doubted",
      content: "beta",
      distance: NEAR,
      confidence: 0.5,
    });
    put({
      id: "memory:trusted",
      content: "alpha",
      distance: NEAR,
      confidence: 1,
    });
    const result = await search({ query: "deployment" });
    expect(ids(result)).toEqual(["memory:trusted", "memory:doubted"]);
  });
});

describe("project_memory_search text admission", () => {
  const QUERY = "sync seam crypto";

  test("a far row containing every query term is returned with null distance", async () => {
    put({
      id: "memory:all-terms",
      content: "the sync seam owns all crypto",
      distance: FAR,
    });
    put({
      id: "memory:one-term",
      content: "crypto keys rotate monthly",
      distance: FAR,
    });
    const result = await search({ query: QUERY });
    expect(ids(result)).toEqual(["memory:all-terms"]);
    expect(result.results[0]?.distance).toBeNull();
  });

  test("a text hit ranks as a row at the text-equivalent distance", async () => {
    put({
      id: "memory:just-under",
      content: "beta note",
      distance: JUST_UNDER_CROSS,
    });
    put({
      id: "memory:text",
      content: "the sync seam owns all crypto",
      distance: FAR,
    });
    put({
      id: "memory:nearer",
      content: "alpha note",
      distance: NEARER_THAN_TEXT,
    });
    const result = await search({ query: QUERY });
    expect(ids(result)).toEqual([
      "memory:nearer",
      "memory:text",
      "memory:just-under",
    ]);
  });

  test("a row admitted both ways appears once with its distance", async () => {
    put({
      id: "memory:both",
      content: "the sync seam owns all crypto",
      distance: NEAR,
    });
    const result = await search({ query: QUERY });
    expect(ids(result)).toEqual(["memory:both"]);
    expect(result.results[0]?.distance).toBeCloseTo(NEAR, 5);
  });
});

describe("project_memory_search row types and limit", () => {
  test("playbooks are never returned; summaries are", async () => {
    put({
      id: "memory:playbook",
      content: "deployment steps",
      distance: 0,
      type: "playbook",
    });
    put({
      id: "memory:summary",
      content: "session summary",
      distance: NEAR,
      type: "summary",
    });
    const result = await search({ query: "deployment" });
    expect(ids(result)).toEqual(["memory:summary"]);
  });

  test("limit keeps the best-scored rows", async () => {
    put({ id: "memory:third", content: "gamma", distance: JUST_UNDER_CROSS });
    put({ id: "memory:first", content: "alpha", distance: NEARER_THAN_TEXT });
    put({ id: "memory:second", content: "beta", distance: NEAR + MARGIN });
    const result = await search({ query: "deployment", limit: 2 });
    expect(ids(result)).toEqual(["memory:first", "memory:second"]);
  });

  test("limit defaults to 10", async () => {
    const rowCount = DEFAULT_LIMIT + 2;
    for (let i = 0; i < rowCount; i++) {
      put({
        id: `memory:row-${i}`,
        content: `note ${i}`,
        distance: (i * JUST_UNDER_CROSS) / rowCount,
      });
    }
    const result = await search({ query: "deployment" });
    expect(result.results).toHaveLength(DEFAULT_LIMIT);
  });
});

const coldEmbedder: EmbedQuery = async (_text: string) => null;

// No query vector: full-text alone, any shared word, BM25 order.
describe.each([
  { label: "no embedQuery supplied", embedder: undefined },
  { label: "embedQuery resolves null", embedder: coldEmbedder },
])("project_memory_search without a query vector ($label)", ({ embedder }) => {
  const QUERY = "sync seam crypto";
  const ALL_TERMS = "memory:all-terms";
  const ONE_TERM = "memory:one-term";
  const ONE_TERM_CONTENT = "crypto keys rotate monthly";

  const putOneTermRow = () =>
    put({ id: ONE_TERM, content: ONE_TERM_CONTENT, distance: FAR });

  const putTermRows = () => {
    putOneTermRow();
    put({
      id: ALL_TERMS,
      content: "the sync seam owns all crypto",
      distance: FAR,
    });
  };

  test("a row sharing any one query word is returned", async () => {
    putTermRows();
    const result = await searchWithEmbedder({ query: QUERY }, embedder);
    expect(ids(result).sort()).toEqual([ALL_TERMS, ONE_TERM]);
  });

  test("results are in BM25 order: more matched terms first", async () => {
    putTermRows();
    const result = await searchWithEmbedder({ query: QUERY }, embedder);
    expect(ids(result)).toEqual([ALL_TERMS, ONE_TERM]);
  });

  test("every result has null distance and the usual fields", async () => {
    putTermRows();
    const result = await searchWithEmbedder({ query: QUERY }, embedder);
    expect(result.results).toHaveLength(2);
    for (const row of result.results) {
      expect(Object.keys(row).sort()).toEqual([
        "content",
        "created_at",
        "distance",
        "id",
        "project_id",
      ]);
      expect(row.distance).toBeNull();
      expect(typeof row.created_at).toBe("string");
    }
  });

  test("a playbook sharing a query word is not returned", async () => {
    put({
      id: "memory:playbook",
      content: "crypto rotation steps",
      distance: FAR,
      type: "playbook",
    });
    putOneTermRow();
    const result = await searchWithEmbedder({ query: QUERY }, embedder);
    expect(ids(result)).toEqual([ONE_TERM]);
  });

  test("a query sharing no word with any row finds no memories", async () => {
    putTermRows();
    const result = await searchWithEmbedder(
      { query: "kubernetes ingress" },
      embedder,
    );
    expect(result.results).toEqual([]);
    expect(result.message).toBe(NO_MEMORIES);
  });

  test("limit caps the results", async () => {
    putTermRows();
    put({ id: "memory:another", content: "crypto audit log", distance: FAR });
    const result = await searchWithEmbedder(
      { query: QUERY, limit: 2 },
      embedder,
    );
    expect(result.results).toHaveLength(2);
  });
});

describe("project_memory_search project resolution", () => {
  test("resolveProjectId receives the project argument as given", async () => {
    const calls: Array<string | undefined> = [];
    const resolver = async (project: string | undefined) => {
      calls.push(project);
      return project;
    };
    await search({ query: "deployment", project: ACTIVE_PROJECT }, resolver);
    expect(calls).toEqual([ACTIVE_PROJECT]);
  });

  test("resolveProjectId receives undefined when project is omitted", async () => {
    const calls: Array<string | undefined> = [];
    const resolver = async (project: string | undefined) => {
      calls.push(project);
      return ACTIVE_PROJECT;
    };
    await search({ query: "deployment" }, resolver);
    // toEqual would let [] stand in for [undefined].
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeUndefined();
  });

  test("with no resolver every row is held to the cross-project ceiling", async () => {
    put({
      id: "memory:between",
      content: "alpha note",
      distance: BETWEEN_CEILINGS,
      project: ACTIVE_PROJECT,
    });
    put({
      id: "memory:near",
      content: "beta note",
      distance: NEAR,
      project: ACTIVE_PROJECT,
    });
    const result = await executeOrgMemoryTool(
      replica,
      SEARCH,
      { query: "deployment" },
      embedQuery,
    );
    const parsed = JSON.parse(result.content) as SearchResult;
    expect(ids(parsed)).toEqual(["memory:near"]);
  });
});
