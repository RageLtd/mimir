/**
 * Local hygiene tests — pure algorithm ports (clustering, scoring) plus
 * the sweep driver against a real replica and a stub judgment endpoint.
 * Embeddings are constructed 2D unit vectors so pairwise cosine distances
 * are exact and controllable.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrgReplica, generateMemoryId } from "../store/org-replica";
import {
  groupClusters,
  runLocalHygieneSweep,
  scoreMemory,
} from "./hygiene";

let savedHome: string | undefined;

beforeEach(() => {
  savedHome = process.env.MIMIR_HOME;
  process.env.MIMIR_HOME = mkdtempSync(join(tmpdir(), "mimir-hyg-test-"));
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = savedHome;
});

/** Unit vector at angle θ → cosine distance to vec(0) is exactly 1−cos(θ). */
const vec = (theta: number) => [Math.cos(theta), Math.sin(theta)];
/** θ for a desired cosine distance d from vec(0). */
const angleFor = (d: number) => Math.acos(1 - d);

const embedNull = async () => null;

describe("groupClusters (verbatim port)", () => {
  test("transitive union, size cap, deterministic order", () => {
    const clusters = groupClusters(
      [
        { a: "m3", b: "m2", distance: 0.1 },
        { a: "m1", b: "m2", distance: 0.15 },
        { a: "m9", b: "m8", distance: 0.5 }, // above mergeDistance — ignored
        { a: "x1", b: "x2", distance: 0.05 },
      ],
      { mergeDistance: 0.18, maxClusterSize: 2 },
    );
    // m1-m2-m3 unite transitively, then cap to 2; x1-x2 separate.
    expect(clusters).toEqual([
      ["m1", "m2"],
      ["x1", "x2"],
    ]);
  });
});

describe("scoreMemory (verbatim port)", () => {
  const now = Date.parse("2026-07-08T00:00:00Z");
  test("fresh + accessed scores high; stale + unaccessed sinks", () => {
    const fresh = scoreMemory(
      {
        confidence: 1,
        access_count: 10,
        last_accessed: "2026-07-07T00:00:00Z",
      },
      now,
    );
    const stale = scoreMemory(
      { confidence: 0.5, access_count: 0, last_accessed: "2026-01-01T00:00:00Z" },
      now,
    );
    expect(fresh).toBeGreaterThan(0.85);
    expect(stale).toBeLessThan(0.15);
  });
});

// ── Sweep driver ──

type StubBehavior = {
  merge?: string;
  classify?: { action: string; survivor: 1 | 2 | null; reason: string };
};

const withJudge = async (
  behavior: StubBehavior,
  fn: (config: { baseUrl: string; model: string }) => Promise<void>,
) => {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as {
        messages: { role: string; content: string }[];
      };
      const system = body.messages[0]?.content ?? "";
      const content = system.startsWith("You consolidate")
        ? (behavior.merge ?? "merged statement")
        : JSON.stringify(
            behavior.classify ?? { action: "leave", survivor: null, reason: "" },
          );
      return Response.json({ choices: [{ message: { content } }] });
    },
  });
  await fn({
    baseUrl: `http://127.0.0.1:${server.port}`,
    model: "judge-model",
  }).finally(() => server.stop(true));
};

const newReplica = () =>
  createOrgReplica(join(process.env.MIMIR_HOME as string, "hygiene.db"));

const seed = (
  replica: ReturnType<typeof createOrgReplica>,
  content: string,
  embedding: number[] | null,
  extra: Partial<{
    created_at: string;
    last_accessed: string;
    confidence: number;
    access_count: number;
  }> = {},
) => {
  const id = generateMemoryId();
  replica.upsertMemory({
    id,
    content,
    type: "fact",
    embedding,
    ...extra,
  });
  return id;
};

describe("runLocalHygieneSweep", () => {
  test("dry run proposes a merge but mutates nothing", async () => {
    const replica = newReplica();
    seed(replica, "the port is 46337", vec(0));
    seed(replica, "embedder port: 46337", vec(angleFor(0.1)));
    await withJudge({ merge: "The embedder port is 46337." }, async (config) => {
      const report = await runLocalHygieneSweep({
        replica,
        config,
        embed: embedNull,
      });
      expect(report.dryRun).toBe(true);
      expect(report.clustersFound).toBe(1);
      expect(report.proposals[0]?.merged).toBe("The embedder port is 46337.");
      expect(report.proposals[0]?.applied).toBe(false);
      expect(replica.countMemories()).toBe(2);
    });
    replica.close();
  });

  test("live merge is delete+delete+create", async () => {
    const replica = newReplica();
    const a = seed(replica, "the port is 46337", vec(0));
    const b = seed(replica, "embedder port: 46337", vec(angleFor(0.1)));
    await withJudge({ merge: "The embedder port is 46337." }, async (config) => {
      const report = await runLocalHygieneSweep({
        replica,
        config,
        embed: embedNull,
        dryRun: false,
      });
      expect(report.proposals[0]?.applied).toBe(true);
      expect(replica.countMemories()).toBe(1);
      // Both originals gone — the survivor is a NEW record (LWW shape).
      expect(replica.getMemory(a)).toBeNull();
      expect(replica.getMemory(b)).toBeNull();
      const [rest] = replica.listMemories(5);
      expect(rest?.content).toBe("The embedder port is 46337.");
      expect(rest?.id).not.toBe(a);
      expect(rest?.id).not.toBe(b);
    });
    replica.close();
  });

  test("contradiction band pair demotes the loser's confidence", async () => {
    const replica = newReplica();
    const winner = seed(replica, "spark has 128GB RAM", vec(0));
    const loser = seed(replica, "spark has 32GB RAM", vec(angleFor(0.25)), {
      confidence: 1,
    });
    await withJudge(
      { classify: { action: "demote", survivor: 1, reason: "hw upgraded" } },
      async (config) => {
        const report = await runLocalHygieneSweep({
          replica,
          config,
          embed: embedNull,
          dryRun: false,
        });
        expect(report.contradictions[0]?.action).toBe("demote");
        expect(report.contradictions[0]?.applied).toBe(true);
        const demoted = replica
          .listFactsWithEmbeddings()
          .find((f) => f.id === loser);
        expect(demoted?.confidence).toBeCloseTo(0.3, 5);
        const kept = replica
          .listFactsWithEmbeddings()
          .find((f) => f.id === winner);
        expect(kept?.confidence ?? 1).toBe(1);
      },
    );
    replica.close();
  });

  test("forgetting decays untouched facts and prunes below the floor", async () => {
    const replica = newReplica();
    // Old, unaccessed, low confidence → prunes. Fresh one survives.
    const doomed = seed(replica, "ancient trivia", null, {
      created_at: "2026-01-01 00:00:00",
      last_accessed: "2026-01-01 00:00:00",
      confidence: 0.4,
    });
    const kept = seed(replica, "current fact", null, {
      created_at: "2026-07-07 00:00:00",
      last_accessed: "2026-07-07 00:00:00",
    });
    await withJudge({}, async (config) => {
      const report = await runLocalHygieneSweep({
        replica,
        config,
        embed: embedNull,
        dryRun: false,
        lastSweepMs: Date.parse("2026-07-01T00:00:00Z"),
        now: Date.parse("2026-07-08T00:00:00Z"),
      });
      expect(report.decayed).toBe(1); // only the untouched one
      expect(report.pruned).toBe(1);
      expect(replica.getMemory(doomed)).toBeNull();
      expect(replica.getMemory(kept)).not.toBeNull();
    });
    replica.close();
  });
});
