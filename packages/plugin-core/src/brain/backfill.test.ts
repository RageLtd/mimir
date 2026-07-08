/**
 * Backfill tests — real replica in a temp dir, stub embedding server
 * (same pattern as embedder.test.ts). Covers full-drain batching, the
 * playbook embed-source rule, embedder-down degradation, and idempotency.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOrgReplica,
  generateMemoryId,
  memoryEmbedSource,
} from "../store/org-replica";
import { EMBEDDER_MODEL } from "./embedder";
import { backfillEmbeddings } from "./backfill";

const SAVED_KEYS = ["MIMIR_EMBEDDER_PORT", "MIMIR_HOME"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of SAVED_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.MIMIR_HOME = mkdtempSync(join(tmpdir(), "mimir-backfill-test-"));
});

afterEach(() => {
  for (const key of SAVED_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const silent = () => {};
const DIMS = EMBEDDER_MODEL.dimensions;

const newReplica = () =>
  createOrgReplica(
    join(process.env.MIMIR_HOME as string, "backfill-replica.db"),
  );

const seedFact = (replica: ReturnType<typeof createOrgReplica>, n: number) => {
  for (let i = 0; i < n; i++) {
    replica.upsertMemory({
      id: generateMemoryId(),
      content: `imported memory number ${i}`,
      type: "fact",
    });
  }
};

/** Stub embedder recording every input it was asked to embed. */
const withEmbedStub = async (
  fn: (inputs: () => string[]) => Promise<void>,
) => {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/health") return Response.json({ status: "ok" });
      const body = (await req.json()) as { input: string[] };
      seen.push(...body.input);
      return Response.json({
        data: body.input.map((_, index) => ({
          embedding: new Array(DIMS).fill(0.1),
          index,
        })),
      });
    },
  });
  process.env.MIMIR_EMBEDDER_PORT = String(server.port);
  await fn(() => seen).finally(() => server.stop(true));
};

describe("backfillEmbeddings", () => {
  test("drains multiple batches and reports the count", async () => {
    const replica = newReplica();
    seedFact(replica, 70); // > BATCH_SIZE forces a second batch
    await withEmbedStub(async () => {
      const result = await backfillEmbeddings(replica, silent);
      expect(result.error).toBeNull();
      expect(result.embedded).toBe(70);
      expect(replica.listUnembedded(1)).toEqual([]);
    });
    replica.close();
  });

  test("second run is a no-op (idempotent)", async () => {
    const replica = newReplica();
    seedFact(replica, 3);
    await withEmbedStub(async (inputs) => {
      await backfillEmbeddings(replica, silent);
      const before = inputs().length;
      const again = await backfillEmbeddings(replica, silent);
      expect(again).toEqual({ embedded: 0, error: null });
      expect(inputs().length).toBe(before);
    });
    replica.close();
  });

  test("playbooks embed name+trigger, not content (shared rule)", async () => {
    const replica = newReplica();
    replica.upsertMemory({
      id: generateMemoryId(),
      content: "step one, step two",
      type: "playbook",
      name: "deploy-runbook",
      trigger: "when deploying to staging",
    });
    await withEmbedStub(async (inputs) => {
      await backfillEmbeddings(replica, silent);
      expect(inputs()).toEqual([
        memoryEmbedSource({
          type: "playbook",
          name: "deploy-runbook",
          trigger: "when deploying to staging",
          content: "step one, step two",
        }),
      ]);
      expect(inputs()[0]).toContain("deploy-runbook");
      expect(inputs()[0]).not.toContain("step one");
    });
    replica.close();
  });

  test("embedder unavailable surfaces an error with progress preserved", async () => {
    const replica = newReplica();
    seedFact(replica, 2);
    process.env.MIMIR_EMBEDDER_PORT = "45991"; // nothing listens
    const result = await backfillEmbeddings(replica, silent);
    expect(result.embedded).toBe(0);
    expect(result.error).toContain("embedder unavailable");
    // Rows remain unembedded for the next attempt.
    expect(replica.listUnembedded(10)).toHaveLength(2);
    replica.close();
  });

  test("empty replica reports zero without touching the network", async () => {
    const replica = newReplica();
    process.env.MIMIR_EMBEDDER_PORT = "45991";
    expect(await backfillEmbeddings(replica, silent)).toEqual({
      embedded: 0,
      error: null,
    });
    replica.close();
  });
});
