import { beforeEach, describe, expect, test } from "bun:test";
import { createOrgReplica, type OrgReplica } from "../store/org-replica";
import { retrieveLocalContext } from "./retrieve";

let replica: OrgReplica;

beforeEach(() => {
  replica = createOrgReplica(":memory:");
});

const QUERY = "why does the gateway time out";
const embedQuery = async (text: string) => (text === QUERY ? [1, 0, 0] : null);

/** A unit vector at exactly this cosine distance from the query vector. */
const at = (distance: number) => {
  const cos = 1 - distance;
  return [cos, Math.sqrt(1 - cos * cos), 0];
};

const NEAR = 0.1;
const FAR = 0.6;
const OURS = "project:a";
const OLDER = "where the session before last left off";
const NEARBY = "the gateway timeout was the pool size";
const FACT = "the gateway pool holds ten connections";

const store = (
  id: string,
  content: string,
  distance: number,
  type?: "summary",
) =>
  replica.upsertMemory({
    id,
    content,
    embedding: at(distance),
    created_at: "2026-10-18 09:30:00",
    project_id: OURS,
    ...(type ? { type } : {}),
  });

describe("retrieveLocalContext — session start", () => {
  test("a summary cap of zero injects no summary, even at session start", async () => {
    replica.upsertMemory({
      id: "summary:ours",
      content: "where the last session left off",
      embedding: at(FAR),
      created_at: "2026-10-18 09:30:00",
      project_id: "project:a",
      type: "summary",
    });

    const result = await retrieveLocalContext(replica, QUERY, {
      embedQuery,
      projectId: "project:a",
      summaryCount: 0,
      sessionStart: true,
    });

    expect(result.summaryCount).toBe(0);
    expect(result.injectedIds).not.toContain("summary:ours");
    expect(result.contextBlock).not.toContain(
      "where the last session left off",
    );
  });
});

describe("retrieveLocalContext — a summary still being written", () => {
  test("defers the summary slot rather than fill it with the older summary; facts still arrive", async () => {
    store("summary:older", OLDER, FAR, "summary");
    store("memory:fact", FACT, NEAR);

    const result = await retrieveLocalContext(replica, QUERY, {
      embedQuery,
      projectId: OURS,
      sessionStart: true,
      summaryPending: true,
    });

    expect(result.summaryDeferred).toBe(true);
    expect(result.summaryCount).toBe(0);
    expect(result.injectedIds).not.toContain("summary:older");
    expect(result.contextBlock).not.toContain(OLDER);
    expect(result.memoryCount).toBe(1);
    expect(result.injectedIds).toContain("memory:fact");
    expect(result.contextBlock).toContain(FACT);
  });

  test("defers even when there is nothing else to inject", async () => {
    store("summary:older", OLDER, FAR, "summary");

    const result = await retrieveLocalContext(replica, QUERY, {
      embedQuery,
      projectId: OURS,
      sessionStart: true,
      summaryPending: true,
    });

    expect(result.summaryDeferred).toBe(true);
    expect(result.contextBlock).toBe("");
  });

  test("a summary near the prompt is injected as normal, but the wait for the pending one goes on", async () => {
    store("summary:near", NEARBY, NEAR, "summary");
    store("summary:older", OLDER, FAR, "summary");

    const result = await retrieveLocalContext(replica, QUERY, {
      embedQuery,
      projectId: OURS,
      sessionStart: true,
      summaryPending: true,
    });

    expect(result.summaryDeferred).toBe(true);
    expect(result.summaryCount).toBe(1);
    expect(result.injectedIds).toContain("summary:near");
    expect(result.contextBlock).toContain(NEARBY);
    // The recency fallback still stays out of the slot.
    expect(result.injectedIds).not.toContain("summary:older");
    expect(result.contextBlock).not.toContain(OLDER);
  });

  test("another project's summary near the prompt does not cancel the wait", async () => {
    replica.upsertMemory({
      id: "summary:theirs",
      content: NEARBY,
      embedding: at(NEAR),
      created_at: "2026-10-18 09:30:00",
      project_id: "project:b",
      type: "summary",
    });

    const result = await retrieveLocalContext(replica, QUERY, {
      embedQuery,
      projectId: OURS,
      sessionStart: true,
      summaryPending: true,
    });

    expect(result.summaryDeferred).toBe(true);
  });

  test("a summary cap of zero never defers, even with a summary pending", async () => {
    store("summary:near", NEARBY, NEAR, "summary");

    const result = await retrieveLocalContext(replica, QUERY, {
      embedQuery,
      projectId: OURS,
      summaryCount: 0,
      sessionStart: true,
      summaryPending: true,
    });

    expect(result.summaryDeferred).toBe(false);
    expect(result.summaryCount).toBe(0);
    expect(result.contextBlock).not.toContain(NEARBY);
  });

  test("with nothing pending, the newest summary fills the slot as before and nothing is deferred", async () => {
    store("summary:older", OLDER, FAR, "summary");

    for (const summaryPending of [false, undefined]) {
      const result = await retrieveLocalContext(replica, QUERY, {
        embedQuery,
        projectId: OURS,
        sessionStart: true,
        summaryPending,
      });

      expect(result.summaryDeferred).toBe(false);
      expect(result.injectedIds).toContain("summary:older");
      expect(result.contextBlock).toContain(OLDER);
    }
  });

  test("with nothing pending and no summary at all, nothing is deferred", async () => {
    const result = await retrieveLocalContext(replica, QUERY, {
      embedQuery,
      projectId: OURS,
      sessionStart: true,
    });

    expect(result.summaryDeferred).toBe(false);
    expect(result.contextBlock).toBe("");
  });

  test("pending has no effect after the session's first prompt", async () => {
    store("summary:older", OLDER, FAR, "summary");
    store("memory:fact", FACT, NEAR);

    const result = await retrieveLocalContext(replica, QUERY, {
      embedQuery,
      projectId: OURS,
      summaryPending: true,
    });

    expect(result.summaryDeferred).toBe(false);
    expect(result.summaryCount).toBe(0);
    expect(result.injectedIds).toEqual(["memory:fact"]);
  });
});
