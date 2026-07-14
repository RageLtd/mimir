import { describe, expect, test } from "bun:test";
import {
  awaitsMigration,
  filterManagedMemories,
  groupManagedMemories,
  managedMemory,
  parseAdminPull,
  parseMaintenanceResult,
} from "./admin-memory-model";
import { payloadFor, type MemoryRecord, type WireEnvelope } from "./memory-model";

const envelope = (overrides: Partial<WireEnvelope> = {}) => ({
  id: "memory:one",
  kind: 1,
  v: 2,
  suite: 1,
  keyGen: 3,
  version: 1,
  tombstone: false,
  nonce: "AAECAwQFBgcICQoL",
  payload: "AAECAwQFBgcICQoLDA0ODw",
  ...overrides,
});

const memory = (overrides: Partial<MemoryRecord> = {}) => ({
  id: "memory:one",
  version: 1,
  content: "the dwarves demand quality",
  projectId: "project:a",
  type: "fact",
  name: null,
  trigger: null,
  confidence: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  ...overrides,
});

describe("admin memory wire model", () => {
  test("accepts bounded v2 ciphertext and rejects cross-org or oversized pages", () => {
    const pulled = parseAdminPull(
      { orgId: "org-a", envelopes: [envelope()], nextCursor: 4 },
      "org-a",
    );
    expect(pulled.envelopes).toHaveLength(1);
    expect(pulled.nextCursor).toBe(4);
    expect(() =>
      parseAdminPull(
        { orgId: "org-b", envelopes: [envelope()], nextCursor: 4 },
        "org-a",
      ),
    ).toThrow(/wrong organization/);
    expect(() =>
      parseAdminPull(
        {
          orgId: "org-a",
          envelopes: [envelope({ payload: "A".repeat(1_500_001) })],
          nextCursor: 4,
        },
        "org-a",
      ),
    ).toThrow(/unsupported envelope/);
  });

  test("classifies legacy and plaintext envelopes for migration without opening them", () => {
    const legacy = envelope({ v: 1 });
    const plaintext = envelope({ suite: 0, keyGen: 0, nonce: "" });
    const pulled = parseAdminPull(
      { orgId: "org-a", envelopes: [legacy, plaintext], nextCursor: 2 },
      "org-a",
    );
    expect(pulled.envelopes.map(awaitsMigration)).toEqual([true, true]);
    expect(awaitsMigration(envelope())).toBe(false);
  });

  test("keeps generation and conflict state local while filtering and grouping", () => {
    const first = managedMemory(envelope(), payloadFor(memory()));
    const secondEnvelope = envelope({ id: "memory:two", keyGen: 4 });
    const second = managedMemory(
      secondEnvelope,
      payloadFor(
        memory({
          id: "memory:two",
          projectId: null,
          type: "summary",
          updatedAt: "2026-01-03T00:00:00.000Z",
        }),
      ),
      true,
    );
    const result = filterManagedMemories([first, second], {
      query: "dwarves",
      project: "",
      type: "",
      generation: "4",
      syncState: "conflict",
      page: 1,
    });
    expect(result.rows.map((row) => row.id)).toEqual(["memory:two"]);
    expect(Array.from(groupManagedMemories([first, second], "type").keys())).toEqual([
      "fact",
      "summary",
    ]);
  });

  test("requires a complete bounded maintenance result", () => {
    expect(parseMaintenanceResult({ accepted: 2, stale: [] }, 2)).toEqual({
      stale: [],
      complete: true,
    });
    expect(
      parseMaintenanceResult({ accepted: 1, stale: ["memory:two"] }, 2),
    ).toMatchObject({ complete: false });
    expect(parseMaintenanceResult({ accepted: "2", stale: [] }, 2)).toBeNull();
  });
});
