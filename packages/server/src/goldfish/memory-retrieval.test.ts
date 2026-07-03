import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test. retrieveMemories is
// the shared FACT top-K path; this file proves playbooks are excluded from it
// (they have their own index + ambient budget, see playbook.ts) so the two
// never crowd each other.
// ---------------------------------------------------------------------------

type StoreRow = {
  id: string;
  content: string;
  type?: string;
  distance?: number;
  last_accessed?: string;
  confidence?: number;
  project?: string;
};

const mockSearchByVector = mock<() => Promise<StoreRow[]>>(() =>
  Promise.resolve([]),
);
const mockSearchByText = mock<() => Promise<StoreRow[]>>(() =>
  Promise.resolve([]),
);
const mockGetRelated = mock<() => Promise<StoreRow[]>>(() =>
  Promise.resolve([]),
);
const mockTouch = mock<() => Promise<void>>(() => Promise.resolve());
const mockEmbedOne = mock<() => Promise<number[] | null>>(() =>
  Promise.resolve(new Array(8).fill(0.1)),
);

mock.module("./store", () => ({
  searchByVector: mockSearchByVector,
  searchByText: mockSearchByText,
  getRelatedMemories: mockGetRelated,
  touchMemories: mockTouch,
  computeFreshness: () => 1,
  // Unused by retrieveMemories but imported by the module — provide stubs.
  findDuplicate: mock(() => Promise.resolve(null)),
  findNeighbors: mock(() => Promise.resolve([])),
  createRelation: mock(() => Promise.resolve()),
  storeMemory: mock(() => Promise.resolve("memory:x")),
}));

mock.module("./clients", () => ({
  embedOne: mockEmbedOne,
  embed: mock(() => Promise.resolve(null)),
  extractMemories: mock(() => Promise.resolve([])),
}));

// Import AFTER mocking
import { retrieveMemories } from "./memory";

describe("retrieveMemories playbook exclusion", () => {
  beforeEach(() => {
    mockSearchByVector.mockClear();
    mockSearchByText.mockClear();
    mockGetRelated.mockClear();
    mockTouch.mockClear();
    mockEmbedOne.mockClear();
  });

  test("playbooks never enter the fact top-K, even when nearest", async () => {
    // The playbook has the SMALLER distance — without the type guard it would
    // rank first. It must not appear in the fact result.
    mockSearchByVector.mockResolvedValueOnce([
      { id: "memory:pb", content: "PLAYBOOK BODY STEPS", type: "playbook", distance: 0.02, confidence: 1 },
      { id: "memory:fact", content: "a relevant fact", type: "fact", distance: 0.2, confidence: 1 },
    ]);

    const result = await retrieveMemories([
      { role: "user", content: "audit the env vars" },
    ]);

    expect(result).toContain("a relevant fact");
    expect(result).not.toContain("PLAYBOOK BODY STEPS");
  });

  test("a result of only playbooks collapses to null (nothing for facts)", async () => {
    mockSearchByVector.mockResolvedValueOnce([
      { id: "memory:pb", content: "only a playbook", type: "playbook", distance: 0.02, confidence: 1 },
    ]);

    const result = await retrieveMemories([
      { role: "user", content: "some task" },
    ]);

    expect(result).toBeNull();
  });
});
