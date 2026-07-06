import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import * as surreal from "../../db/surreal";
import { clearStaleHygiene, startHygiene } from "./state";

describe("hygiene lock", () => {
  let queryMock: ReturnType<typeof mock>;
  let queryOneMock: ReturnType<typeof mock>;

  beforeEach(() => {
    queryMock = mock(() => Promise.resolve([[]]));
    queryOneMock = mock(() => Promise.resolve([]));

    spyOn(surreal, "getDb").mockImplementation(
      async () => ({ query: queryMock }) as any,
    );
    spyOn(surreal, "queryOne").mockImplementation(queryOneMock as any);
  });

  afterEach(() => {
    mock.restore();
  });

  test("acquires the lock when no sweep is running", async () => {
    // UPDATE ... WHERE is_running = false matched a row → lock acquired
    queryOneMock.mockResolvedValueOnce([
      { id: "hygiene_state:global", is_running: true },
    ]);

    expect(await startHygiene("test-org")).toBe(true);
  });

  test("fails to acquire when a sweep is already running", async () => {
    // UPDATE matched nothing because is_running was already true
    queryOneMock.mockResolvedValueOnce([]);

    expect(await startHygiene("test-org")).toBe(false);
  });

  test("acquisition query gates on is_running = false", async () => {
    queryOneMock.mockResolvedValueOnce([{ id: "hygiene_state:global" }]);

    await startHygiene("test-org");

    const updateCall = queryOneMock.mock.calls.find((c) =>
      String(c[0]).includes("UPDATE"),
    );
    expect(String(updateCall?.[0])).toContain("is_running = false");
  });

  test("clearStaleHygiene reports whether it cleared a stuck lock", async () => {
    queryOneMock.mockResolvedValueOnce([{ id: "hygiene_state:global" }]);
    expect(await clearStaleHygiene()).toBe(true);

    queryOneMock.mockResolvedValueOnce([]);
    expect(await clearStaleHygiene()).toBe(false);
  });

  test("clearStaleHygiene only touches locks older than the stale window", async () => {
    queryOneMock.mockResolvedValueOnce([]);

    await clearStaleHygiene(30);

    const call = queryOneMock.mock.calls.at(-1);
    expect(String(call?.[0])).toContain("is_running = true");
    expect(String(call?.[0])).toContain("30m");
  });
});
