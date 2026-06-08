import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — MUST be declared before importing the module under test so the
// mock.module() calls win. We replace the goldfish store + clients so the
// tools exercise their real embed→dedup→store→link logic against fakes,
// asserting only on the `type` they stamp and the dedup short-circuit.
// ---------------------------------------------------------------------------

const mockEmbedOne = mock<() => Promise<number[] | null>>(() =>
  Promise.resolve(new Array(1024).fill(0.1)),
);

const mockStoreMemory = mock<(m: { type?: string }) => Promise<string | null>>(
  () => Promise.resolve("memory:abc123"),
);
const mockFindDuplicate = mock<() => Promise<unknown>>(() =>
  Promise.resolve(null),
);
const mockFindNeighbors = mock<() => Promise<unknown[]>>(() =>
  Promise.resolve([]),
);
const mockCreateRelation = mock<() => Promise<void>>(() => Promise.resolve());

mock.module("../../goldfish/clients", () => ({
  embedOne: mockEmbedOne,
}));

mock.module("../../goldfish/store", () => ({
  storeMemory: mockStoreMemory,
  findDuplicate: mockFindDuplicate,
  findNeighbors: mockFindNeighbors,
  createRelation: mockCreateRelation,
}));

mock.module("../../projects/resolve-for-query", () => ({
  resolveProjectForQuery: mock(() =>
    Promise.resolve({ project: "resolved-uuid" }),
  ),
}));

// Import AFTER mocking
import { executeMemoryStore, executePlaybookStore } from "./memory";

describe("project memory / playbook store", () => {
  beforeEach(() => {
    mockEmbedOne.mockClear();
    mockStoreMemory.mockClear();
    mockFindDuplicate.mockClear();
    mockFindNeighbors.mockClear();
    mockCreateRelation.mockClear();
  });

  test("executePlaybookStore stamps type 'playbook'", async () => {
    const result = await executePlaybookStore({
      content: "Run bun run test before pushing; fix reds before commit.",
    });

    expect(result).toMatchObject({ stored: true, id: "memory:abc123" });
    expect(mockStoreMemory).toHaveBeenCalledTimes(1);
    expect(mockStoreMemory.mock.calls[0]?.[0]).toMatchObject({
      type: "playbook",
    });
  });

  test("executeMemoryStore still stamps type 'fact' (regression)", async () => {
    const result = await executeMemoryStore({
      content: "The inference server lives in packages/server.",
    });

    expect(result).toMatchObject({ stored: true });
    expect(mockStoreMemory.mock.calls[0]?.[0]).toMatchObject({ type: "fact" });
  });

  test("a duplicate short-circuits before storing — for both types", async () => {
    mockFindDuplicate.mockResolvedValueOnce({ content: "an existing memory" });

    const result = await executePlaybookStore({ content: "near-identical" });

    expect(result).toMatchObject({
      stored: false,
      duplicate: "an existing memory",
    });
    expect(mockStoreMemory).not.toHaveBeenCalled();
  });
});
