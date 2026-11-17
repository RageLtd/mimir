import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../logger";
import { createOrgReplica } from "../store/org-replica";
import type { storeTyped } from "../tools/org-memory";
import { openFactStore, storeFacts } from "./fact-store";

const PROJECT = "project:facts";
const REPLICA_FILE = "org-replica.db";

let home: string;
const savedReplicaDb = process.env.MIMIR_ORG_REPLICA_DB;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mimir-fact-store-"));
  process.env.MIMIR_ORG_REPLICA_DB = join(home, REPLICA_FILE);
});

afterEach(async () => {
  process.env.MIMIR_ORG_REPLICA_DB = savedReplicaDb;
  await rm(home, { recursive: true, force: true });
});

type StoreArgs = Parameters<typeof storeTyped>[2];

const recordingLogger = () => {
  const warnings: unknown[][] = [];
  const log: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, context) => {
      warnings.push([message, context]);
    },
    error: () => undefined,
  };
  return { warnings, log };
};

/** A storeTyped stand-in: answers per content, records every call. */
const fakeStoreTyped = (
  answer: (content: string) => "stored" | "duplicate" | Error,
) => {
  const calls: StoreArgs[] = [];
  const fake: typeof storeTyped = async (_replica, _embedQuery, args) => {
    calls.push(args);
    const outcome = answer(args.content);
    if (outcome instanceof Error) throw outcome;
    if (outcome === "duplicate") {
      return {
        stored: false,
        duplicate: args.content,
        message: "Similar memory exists",
      };
    }
    return {
      stored: true,
      id: `memory:${calls.length}`,
      neighbors_linked: 0,
      error: null,
    };
  };
  return { calls, fake };
};

const storeFor = (projectId: string | null) => ({
  projectId,
  replica: createOrgReplica(join(home, REPLICA_FILE)),
  embedQuery: async () => null,
});

describe("openFactStore", () => {
  test("opens the org replica at MIMIR_ORG_REPLICA_DB with the query embedder", async () => {
    const store = await openFactStore(PROJECT);
    expect(store.projectId).toBe(PROJECT);
    expect(typeof store.embedQuery).toBe("function");

    const id = store.replica.storeMemory({
      content: "replica is usable",
      type: "fact",
    });
    store.replica.close();

    const reopened = createOrgReplica(join(home, REPLICA_FILE));
    expect(reopened.getMemory(id)?.content).toBe("replica is usable");
    reopened.close();
  });

  test("carries a null project id through", async () => {
    const store = await openFactStore(null);
    expect(store.projectId).toBeNull();
    store.replica.close();
  });
});

describe("storeFacts", () => {
  test("stores each memory in order as a project fact and counts stored vs duplicates", async () => {
    const { calls, fake } = fakeStoreTyped((content) =>
      content === "seen before" ? "duplicate" : "stored",
    );
    const { warnings, log } = recordingLogger();
    const store = storeFor(PROJECT);

    const counts = await storeFacts(
      store,
      ["first", "seen before", "third"],
      log,
      {
        storeTyped: fake,
      },
    );

    expect(counts).toEqual({ stored: 2, duplicates: 1 });
    expect(calls).toEqual([
      { content: "first", type: "fact", project: PROJECT },
      { content: "seen before", type: "fact", project: PROJECT },
      { content: "third", type: "fact", project: PROJECT },
    ]);
    expect(warnings).toEqual([]);
    store.replica.close();
  });

  test("passes the store's replica and embedder to storeTyped", async () => {
    const store = storeFor(PROJECT);
    const seen: unknown[] = [];
    const fake: typeof storeTyped = async (replica, embedQuery) => {
      seen.push(replica, embedQuery);
      return { stored: true, id: "memory:1", neighbors_linked: 0, error: null };
    };

    await storeFacts(store, ["only"], recordingLogger().log, {
      storeTyped: fake,
    });

    expect(seen[0]).toBe(store.replica);
    expect(seen[1]).toBe(store.embedQuery);
    store.replica.close();
  });

  test("with no project id, the project key is absent", async () => {
    const { calls, fake } = fakeStoreTyped(() => "stored");
    const store = storeFor(null);

    await storeFacts(store, ["unattributed"], recordingLogger().log, {
      storeTyped: fake,
    });

    expect(calls).toHaveLength(1);
    const [first] = calls;
    if (first === undefined) throw new Error("storeTyped was never called");
    expect("project" in first).toBe(false);
    expect(first).toEqual({ content: "unattributed", type: "fact" });
    store.replica.close();
  });

  test("a failing store is skipped, warned once with its message, and the rest still store", async () => {
    const { calls, fake } = fakeStoreTyped((content) =>
      content === "breaks" ? new Error("embedder exploded") : "stored",
    );
    const { warnings, log } = recordingLogger();
    const store = storeFor(PROJECT);

    const counts = await storeFacts(store, ["before", "breaks", "after"], log, {
      storeTyped: fake,
    });

    expect(counts).toEqual({ stored: 2, duplicates: 0 });
    expect(calls.map((c) => c.content)).toEqual(["before", "breaks", "after"]);
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain("embedder exploded");
    store.replica.close();
  });

  test("does not close the replica", async () => {
    const { fake } = fakeStoreTyped(() => "stored");
    const store = storeFor(PROJECT);

    await storeFacts(store, ["one"], recordingLogger().log, {
      storeTyped: fake,
    });

    expect(() => store.replica.countMemories()).not.toThrow();
    store.replica.close();
  });

  test("an empty list stores nothing and makes no calls", async () => {
    const { calls, fake } = fakeStoreTyped(() => "stored");
    const store = storeFor(PROJECT);

    const counts = await storeFacts(store, [], recordingLogger().log, {
      storeTyped: fake,
    });

    expect(counts).toEqual({ stored: 0, duplicates: 0 });
    expect(calls).toEqual([]);
    store.replica.close();
  });
});
