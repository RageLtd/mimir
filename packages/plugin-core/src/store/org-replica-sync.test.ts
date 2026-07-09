/**
 * MIM-88 replica sync spine: dirty lifecycle, LWW apply matrix,
 * tombstone soft-delete + purge timing, cursor state, and the
 * pre-MIM-88 schema migration.
 */

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOrgReplica } from "./org-replica";
import type { RemoteMemory } from "./org-replica-sync";

const freshReplica = () =>
  createOrgReplica(
    join(mkdtempSync(join(tmpdir(), "mimir-sync-")), "replica.db"),
  );

const remote = (overrides: Partial<RemoteMemory> & { id: string }) =>
  ({
    version: 1,
    tombstone: false,
    content: "remote content",
    project_id: null,
    type: "fact",
    name: null,
    trigger: null,
    confidence: 1,
    created_at: "2026-07-01 00:00:00",
    updated_at: "2026-07-01 00:00:00",
    ...overrides,
  }) satisfies RemoteMemory;

describe("dirty lifecycle", () => {
  test("new stores are dirty; markPushed clears them", () => {
    const replica = freshReplica();
    const id = replica.storeMemory({ content: "fresh fact" });
    expect(replica.listDirty().map((r) => r.id)).toEqual([id]);
    replica.markPushed([id]);
    expect(replica.listDirty()).toHaveLength(0);
  });

  test("updates and confidence changes re-dirty and bump version", () => {
    const replica = freshReplica();
    const id = replica.storeMemory({ content: "v1" });
    replica.markPushed([id]);
    replica.updateMemory(id, "v2");
    const [dirty] = replica.listDirty();
    expect(dirty?.id).toBe(id);
    expect(dirty?.version).toBe(2);
    replica.markPushed([id]);
    replica.setConfidence(id, 0.5);
    expect(replica.listDirty()[0]?.version).toBe(3);
  });

  test("touch and embedding backfill never dirty a row", () => {
    const replica = freshReplica();
    const id = replica.storeMemory({ content: "quiet" });
    replica.markPushed([id]);
    replica.touchMemories([id]);
    replica.setEmbedding(id, [0.1, 0.2, 0.3]);
    expect(replica.listDirty()).toHaveLength(0);
  });
});

describe("tombstones", () => {
  test("delete soft-deletes: invisible everywhere, pushed as dirty", () => {
    const replica = freshReplica();
    const id = replica.storeMemory({ content: "doomed secret" });
    replica.markPushed([id]);
    expect(replica.deleteMemory(id)).toBe(true);

    // Invisible to every read surface.
    expect(replica.getMemory(id)).toBeNull();
    expect(replica.countMemories()).toBe(0);
    expect(replica.searchByText("doomed")).toHaveLength(0);
    expect(replica.listMemories()).toHaveLength(0);

    // But queued for push, with content already blanked.
    const [dirty] = replica.listDirty();
    expect(dirty?.tombstone).toBe(1);
    expect(dirty?.content).toBe("");
    expect(dirty?.version).toBe(2);
  });

  test("markPushed purges pushed tombstones physically", () => {
    const replica = freshReplica();
    const id = replica.storeMemory({ content: "gone" });
    replica.deleteMemory(id);
    replica.markPushed([id]);
    expect(replica.listDirty()).toHaveLength(0);
    // Row is physically gone — a remote record with the same id would
    // now land as a fresh insert.
    expect(replica.applyRemote(remote({ id, version: 9 })).applied).toBe(true);
    expect(replica.getMemory(id)?.content).toBe("remote content");
  });
});

describe("applyRemote LWW matrix", () => {
  test("remote newer wins; lands clean (not dirty), unembedded", () => {
    const replica = freshReplica();
    const id = replica.storeMemory({
      content: "local v1",
      embedding: [1, 0, 0],
    });
    replica.markPushed([id]);
    const result = replica.applyRemote(
      remote({ id, version: 5, content: "remote v5" }),
    );
    expect(result.applied).toBe(true);
    expect(replica.getMemory(id)?.content).toBe("remote v5");
    expect(replica.listDirty()).toHaveLength(0);
    // Embedding cleared — vectors never sync; local backfill re-embeds.
    expect(replica.listUnembedded().map((r) => r.id)).toEqual([id]);
  });

  test("local newer survives (skipped, still dirty for push)", () => {
    const replica = freshReplica();
    const id = replica.storeMemory({ content: "local v1" });
    replica.markPushed([id]);
    replica.updateMemory(id, "local v2"); // version 2, dirty
    const result = replica.applyRemote(
      remote({ id, version: 1, content: "stale remote" }),
    );
    expect(result.applied).toBe(false);
    expect(replica.getMemory(id)?.content).toBe("local v2");
    expect(replica.listDirty()).toHaveLength(1);
  });

  test("equal version + dirty local: local wins the tie (unpushed work survives)", () => {
    const replica = freshReplica();
    const id = replica.storeMemory({ content: "my unpushed edit" });
    // A tie arriving BEFORE we pushed — applying would destroy work.
    const result = replica.applyRemote(
      remote({ id, version: 1, content: "their take" }),
    );
    expect(result.applied).toBe(false);
    expect(replica.getMemory(id)?.content).toBe("my unpushed edit");
    expect(replica.listDirty()).toHaveLength(1);
  });

  test("equal version + clean local: remote wins (echo/tie replay)", () => {
    const replica = freshReplica();
    const id = replica.storeMemory({ content: "pushed content" });
    replica.markPushed([id]);
    const result = replica.applyRemote(
      remote({ id, version: 1, content: "tie winner from elsewhere" }),
    );
    expect(result.applied).toBe(true);
    expect(replica.getMemory(id)?.content).toBe("tie winner from elsewhere");
  });

  test("remote tombstone deletes locally", () => {
    const replica = freshReplica();
    const id = replica.storeMemory({ content: "to be erased remotely" });
    replica.markPushed([id]);
    const result = replica.applyRemote(
      remote({ id, version: 2, tombstone: true }),
    );
    expect(result.applied).toBe(true);
    expect(replica.getMemory(id)).toBeNull();
    expect(replica.countMemories()).toBe(0);
    expect(replica.listDirty()).toHaveLength(0);
  });

  test("unknown ids insert fresh", () => {
    const replica = freshReplica();
    const result = replica.applyRemote(
      remote({ id: "memory:fromelsewhere0001", version: 3 }),
    );
    expect(result.applied).toBe(true);
    expect(replica.getMemory("memory:fromelsewhere0001")?.type).toBe("fact");
  });
});

describe("sync cursor state", () => {
  test("cursor round-trips per org, defaulting to 0", () => {
    const replica = freshReplica();
    expect(replica.getSyncCursor("org-a")).toBe(0);
    replica.setSyncCursor("org-a", 42);
    replica.setSyncCursor("org-b", 7);
    expect(replica.getSyncCursor("org-a")).toBe(42);
    expect(replica.getSyncCursor("org-b")).toBe(7);
    replica.setSyncCursor("org-a", 43);
    expect(replica.getSyncCursor("org-a")).toBe(43);
  });
});

describe("pre-MIM-88 replica migration", () => {
  test("legacy replica gains sync columns; old rows arrive dirty", () => {
    const path = join(mkdtempSync(join(tmpdir(), "mimir-legacy-")), "old.db");
    // Build a pre-sync database by hand (the old SCHEMA shape).
    const legacy = new Database(path);
    legacy.run(`CREATE TABLE memory (
      id TEXT PRIMARY KEY,
      org_id TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      project_id TEXT, type TEXT NOT NULL DEFAULT 'fact',
      name TEXT, trigger TEXT, message_count INTEGER,
      last_message_id TEXT, token_count INTEGER,
      confidence REAL NOT NULL DEFAULT 1.0,
      access_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_accessed TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      embedding BLOB
    )`);
    legacy.run(
      "INSERT INTO memory (id, content) VALUES ('memory:legacyrow000000000001', 'old wisdom')",
    );
    legacy.close();

    const replica = createOrgReplica(path);
    const dirty = replica.listDirty();
    expect(dirty.map((r) => r.id)).toEqual(["memory:legacyrow000000000001"]);
    expect(dirty[0]?.version).toBe(1);
    // Second open is a no-op (idempotent ALTERs).
    replica.close();
    const reopened = createOrgReplica(path);
    expect(reopened.countMemories()).toBe(1);
  });
});
