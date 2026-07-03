import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — MUST be declared before importing the module under test so the
// mock.module() calls win. We replace the goldfish store + clients so the
// tools exercise their real embed→dedup→store→link logic against fakes,
// asserting only on the `type` they stamp and the dedup short-circuit.
// ---------------------------------------------------------------------------

const mockEmbedOne = mock<(text: string) => Promise<number[] | null>>(() =>
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
import { executeMemoryStore, storeTypedMemory } from "./memory";

describe("project memory store", () => {
  beforeEach(() => {
    mockEmbedOne.mockClear();
    mockStoreMemory.mockClear();
    mockFindDuplicate.mockClear();
    mockFindNeighbors.mockClear();
    mockCreateRelation.mockClear();
  });

  test("executeMemoryStore stamps type 'fact'", async () => {
    const result = await executeMemoryStore({
      content: "The inference server lives in packages/server.",
    });

    expect(result).toMatchObject({ stored: true });
    expect(mockStoreMemory.mock.calls[0]?.[0]).toMatchObject({ type: "fact" });
  });

  test("storeTypedMemory embeds a playbook's trigger, not its body", async () => {
    await storeTypedMemory({
      content: "Step 1: do X. Step 2: do Y.",
      type: "playbook",
      name: "do the thing",
      trigger: "use when the thing needs doing",
    });

    // The embedding source is name+trigger for playbooks — the body never
    // reaches embedOne.
    expect(mockEmbedOne).toHaveBeenCalledTimes(1);
    expect(mockEmbedOne.mock.calls[0]?.[0]).toBe(
      "do the thing\nuse when the thing needs doing",
    );
    expect(mockStoreMemory.mock.calls[0]?.[0]).toMatchObject({
      type: "playbook",
      name: "do the thing",
      trigger: "use when the thing needs doing",
    });
  });

  test("a duplicate short-circuits before storing", async () => {
    mockFindDuplicate.mockResolvedValueOnce({ content: "an existing memory" });

    const result = await executeMemoryStore({ content: "near-identical" });

    expect(result).toMatchObject({
      stored: false,
      duplicate: "an existing memory",
    });
    expect(mockStoreMemory).not.toHaveBeenCalled();
  });
});
