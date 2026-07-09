import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — declared before importing the module under test. We replace the
// goldfish playbook data layer + the shared store helper so the tools exercise
// their own selection/validation logic against fakes.
// ---------------------------------------------------------------------------

type FakePlaybook = {
  id: string;
  name?: string;
  trigger?: string;
  content: string;
  project?: string;
};

const mockStoreTypedMemory = mock<
  (
    scope: unknown,
    args: { type: string; name?: string; trigger?: string },
  ) => Promise<unknown>
>(() => Promise.resolve({ stored: true, id: "memory:new" }));

const mockGetPlaybook = mock<
  (scope: unknown, sel: { id?: string; name?: string }) => Promise<
    FakePlaybook | null
  >
>(() => Promise.resolve(null));
const mockListPlaybooks = mock<() => Promise<FakePlaybook[]>>(() =>
  Promise.resolve([]),
);
const mockUpdatePlaybook = mock<
  (scope: unknown, id: string, patch: unknown) => Promise<FakePlaybook | null>
>(() => Promise.resolve(null));
const mockDeleteMemory = mock<(scope: unknown, id: string) => Promise<boolean>>(
  () => Promise.resolve(true),
);

mock.module("./memory", () => ({ storeTypedMemory: mockStoreTypedMemory }));
mock.module("../../goldfish/playbook", () => ({
  getPlaybook: mockGetPlaybook,
  listPlaybooks: mockListPlaybooks,
  updatePlaybook: mockUpdatePlaybook,
}));
mock.module("../../goldfish/store", () => ({ deleteMemory: mockDeleteMemory }));

// Import AFTER mocking
import { testScope } from "../../testing/scope";
import { buildMcpPublicTools } from "./index";
import {
  buildPlaybookTools,
  executePlaybookDelete,
  executePlaybookLoad,
  executePlaybookStore,
  executePlaybookUpdate,
} from "./playbook";

const scope = testScope();

const PLAYBOOK_TOOL_NAMES = [
  "project_playbook_store",
  "project_playbook_list",
  "project_playbook_load",
  "project_playbook_update",
  "project_playbook_delete",
];

beforeEach(() => {
  mockStoreTypedMemory.mockClear();
  mockGetPlaybook.mockClear();
  mockListPlaybooks.mockClear();
  mockUpdatePlaybook.mockClear();
  mockDeleteMemory.mockClear();
});

describe("playbook store", () => {
  test("stamps type 'playbook' and forwards name + trigger", async () => {
    await executePlaybookStore(scope, {
      name: "Audit env",
      trigger: "use when auditing env vars",
      content: "Step 1...",
    });
    expect(mockStoreTypedMemory.mock.calls[0]?.[1]).toMatchObject({
      type: "playbook",
      name: "Audit env",
      trigger: "use when auditing env vars",
    });
  });
});

describe("playbook load", () => {
  test("requires a selector", async () => {
    const result = await executePlaybookLoad(scope, {});
    expect(result).toMatchObject({ found: false });
    expect(mockGetPlaybook).not.toHaveBeenCalled();
  });

  test("returns the full body when found by name", async () => {
    mockGetPlaybook.mockResolvedValueOnce({
      id: "memory:x",
      name: "Audit env",
      trigger: "t",
      content: "the steps",
      project: undefined,
    });
    const result = await executePlaybookLoad(scope, { name: "Audit env" });
    expect(result).toMatchObject({ found: true, content: "the steps" });
  });

  test("reports not found", async () => {
    const result = await executePlaybookLoad(scope, { name: "ghost" });
    expect(result).toMatchObject({ found: false });
  });
});

describe("playbook update", () => {
  test("rejects when nothing to change", async () => {
    const result = await executePlaybookUpdate(scope, { name: "Audit env" });
    expect(result).toMatchObject({ updated: false });
    expect(mockUpdatePlaybook).not.toHaveBeenCalled();
  });

  test("resolves the target then patches via newName/trigger/content", async () => {
    mockGetPlaybook.mockResolvedValueOnce({
      id: "memory:x",
      name: "old",
      trigger: "t",
      content: "c",
    });
    mockUpdatePlaybook.mockResolvedValueOnce({
      id: "memory:x",
      name: "new",
      trigger: "t",
      content: "c",
    });
    const result = await executePlaybookUpdate(scope, {
      name: "old",
      newName: "new",
    });
    expect(result).toMatchObject({ updated: true, name: "new" });
    expect(mockUpdatePlaybook.mock.calls[0]?.[1]).toBe("memory:x");
    expect(mockUpdatePlaybook.mock.calls[0]?.[2]).toMatchObject({
      name: "new",
    });
  });

  test("reports not found without touching the store", async () => {
    const result = await executePlaybookUpdate(scope, {
      name: "ghost",
      content: "x",
    });
    expect(result).toMatchObject({ updated: false });
    expect(mockUpdatePlaybook).not.toHaveBeenCalled();
  });
});

describe("playbook delete", () => {
  test("resolves the target then deletes the underlying memory", async () => {
    mockGetPlaybook.mockResolvedValueOnce({
      id: "memory:x",
      name: "Audit env",
      trigger: "t",
      content: "c",
    });
    const result = await executePlaybookDelete(scope, { name: "Audit env" });
    expect(result).toMatchObject({ deleted: true, id: "memory:x" });
    expect(mockDeleteMemory.mock.calls[0]?.[1]).toBe("memory:x");
  });

  test("requires a selector", async () => {
    const result = await executePlaybookDelete(scope, {});
    expect(result).toMatchObject({ deleted: false });
    expect(mockDeleteMemory).not.toHaveBeenCalled();
  });
});

describe("registration", () => {
  test("all playbook tools are exposed via /mcp for Claude Code parity", () => {
    // /mcp is the only tool surface post-MIM-89 — the agent loop (and
    // buildServerTools with it) left with the inversion.
    const tools = buildMcpPublicTools(scope);
    const playbookTools = buildPlaybookTools(scope);
    for (const name of PLAYBOOK_TOOL_NAMES) {
      expect(name in tools).toBe(true);
      expect(name in playbookTools).toBe(true);
    }
  });
});
