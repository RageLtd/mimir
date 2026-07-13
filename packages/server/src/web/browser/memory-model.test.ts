import { describe, expect, test } from "bun:test";
import {
  applyOpened,
  filterMemories,
  type MemoryRecord,
  parseMemoryPayload,
  parsePull,
  payloadFor,
  type WireEnvelope,
} from "./memory-model";

const memory = (id: string, content: string, projectId: string | null) => ({
  id,
  version: 1,
  content,
  projectId,
  type: "fact",
  name: null,
  trigger: null,
  confidence: 1,
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:00:00.000Z",
}) satisfies MemoryRecord;

const envelope = (overrides: Partial<WireEnvelope> = {}) => ({
  id: "memory:one",
  kind: 1,
  v: 2,
  suite: 1,
  keyGen: 1,
  version: 1,
  tombstone: false,
  nonce: "AAECAwQFBgcICQoL",
  payload: "AAECAwQFBgcICQoLDA0ODw",
  ...overrides,
});

describe("browser memory validation", () => {
  test("accepts the authenticated encrypted envelope shape for the active org", () => {
    expect(
      parsePull(
        { orgId: "org-1", envelopes: [envelope()], nextCursor: 8 },
        "org-1",
      ),
    ).toEqual({ envelopes: [envelope()], nextCursor: 8 });
  });

  test("fails closed on cross-org, plaintext, legacy, and empty tombstones", () => {
    expect(() =>
      parsePull({ orgId: "org-2", envelopes: [], nextCursor: 0 }, "org-1"),
    ).toThrow(/wrong organization/);
    expect(() =>
      parsePull(
        {
          orgId: "org-1",
          envelopes: [envelope({ suite: 0 })],
          nextCursor: 1,
        },
        "org-1",
      ),
    ).toThrow(/unsupported envelope/);
    expect(() =>
      parsePull(
        {
          orgId: "org-1",
          envelopes: [envelope({ v: 1 })],
          nextCursor: 1,
        },
        "org-1",
      ),
    ).toThrow(/unsupported envelope/);
    expect(() =>
      parsePull(
        {
          orgId: "org-1",
          envelopes: [envelope({ tombstone: true, nonce: "", payload: "" })],
          nextCursor: 1,
        },
        "org-1",
      ),
    ).toThrow(/empty encrypted envelope/);
  });

  test("round-trips the sync payload without local-only fields", () => {
    const source = memory("memory:one", "private canary", "project-1");
    expect(parseMemoryPayload(payloadFor(source))).toEqual({
      content: source.content,
      projectId: source.projectId,
      type: source.type,
      name: source.name,
      trigger: source.trigger,
      confidence: source.confidence,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
    });
  });
});

describe("local memory model", () => {
  test("applies LWW records and tombstones", () => {
    const memories = new Map<string, MemoryRecord>();
    const first = memory("memory:one", "first", "alpha");
    applyOpened(memories, envelope(), payloadFor(first));
    expect(memories.get(first.id)?.content).toBe("first");

    expect(
      applyOpened(memories, envelope({ version: 0 }), payloadFor(first)),
    ).toBe(false);
    applyOpened(
      memories,
      envelope({ version: 2, tombstone: true }),
      null,
    );
    expect(memories.size).toBe(0);
  });

  test("searches, filters, sorts, and paginates plaintext locally", () => {
    const rows = [
      memory("memory:one", "alpha browser fact", "project-1"),
      {
        ...memory("memory:two", "beta server fact", "project-2"),
        updatedAt: "2026-07-13T00:00:00.000Z",
      },
    ];
    expect(
      filterMemories(rows, {
        query: "browser",
        project: "project-1",
        type: "fact",
        page: 1,
      }).rows.map((row) => row.id),
    ).toEqual(["memory:one"]);
    expect(
      filterMemories(rows, { query: "", project: "", type: "", page: 1 })
        .rows.map((row) => row.id),
    ).toEqual(["memory:two", "memory:one"]);
  });
});
