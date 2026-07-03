/**
 * Tests for awaitProjectId — the seam that closes the cartographer sync race.
 *
 * autoIndex used to read session.projectId at fire time. When the project
 * resolver hadn't finished, that snapshot was null and the sync landed under
 * the filesystem path, fragmenting one repo across path- and UUID-keyed index
 * records. awaitProjectId waits for the resolver's verdict (bounded by a
 * deadline) so the sync is keyed by the canonical UUID.
 */

import { describe, expect, test } from "bun:test";
import { awaitProjectId } from "./lifecycle";

describe("awaitProjectId", () => {
  test("returns the UUID when the resolver settles before the deadline", async () => {
    const ready = Promise.resolve("4l0le2qveoq6su1u4foj");
    expect(await awaitProjectId(ready, 1000)).toBe("4l0le2qveoq6su1u4foj");
  });

  test("picks up a late-arriving UUID — the fire-time-null case the fix targets", async () => {
    // projectId is unresolved when autoIndex fires; it settles afterwards.
    const ready = new Promise<string | null>((resolve) => {
      setTimeout(() => resolve("late-uuid"), 10);
    });
    expect(await awaitProjectId(ready, 1000)).toBe("late-uuid");
  });

  test("returns null when there is no readiness promise", async () => {
    expect(await awaitProjectId(undefined, 1000)).toBeNull();
  });

  test("returns null when the resolver settles to null", async () => {
    expect(await awaitProjectId(Promise.resolve(null), 1000)).toBeNull();
  });

  test("falls back to null when the resolver misses the deadline", async () => {
    // A resolver that never answers must not wedge indexing forever.
    const never = new Promise<string | null>(() => {});
    expect(await awaitProjectId(never, 5)).toBeNull();
  });
});
