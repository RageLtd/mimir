import { describe, expect, test } from "bun:test";
import { syncAfterDistill } from "./after-distill";

type Line = { level: "info" | "warn"; message: string; context: unknown };

const recorder = () => {
  const lines: Line[] = [];
  return {
    lines,
    log: {
      info: (message: string, context?: unknown) =>
        lines.push({ level: "info", message, context }),
      warn: (message: string, context?: unknown) =>
        lines.push({ level: "warn", message, context }),
    },
  };
};

describe("syncAfterDistill", () => {
  test("logs what the sync pushed", async () => {
    const { lines, log } = recorder();

    await syncAfterDistill(log, {
      sync: async () => ({ status: "synced", pushed: 3 }),
      deadlineMs: 1_000,
    });

    expect(lines).toEqual([
      {
        level: "info",
        message: "post-distill sync",
        context: { status: "synced", pushed: 3 },
      },
    ]);
  });

  test("a sync that throws is a warning, never a failure of the caller", async () => {
    const { lines, log } = recorder();

    await syncAfterDistill(log, {
      sync: async () => {
        throw new Error("relay unreachable");
      },
      deadlineMs: 1_000,
    });

    expect(lines).toEqual([
      {
        level: "warn",
        message: "post-distill sync failed",
        context: { error: "relay unreachable" },
      },
    ]);
  });

  test("a sync slower than the deadline is left behind: the rows stay dirty for the next one", async () => {
    const { lines, log } = recorder();
    const never = Promise.withResolvers<{ status: string }>();

    await syncAfterDistill(log, { sync: () => never.promise, deadlineMs: 5 });

    expect(lines).toEqual([
      {
        level: "info",
        message: "post-distill sync",
        context: { status: "deadline" },
      },
    ]);
  });
});
