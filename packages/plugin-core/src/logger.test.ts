import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLoggerFactory, shouldRotate } from "./logger";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("shouldRotate", () => {
  const now = new Date(2026, 6, 10, 12, 0, 0).getTime();

  test("same-day small file does not rotate", () => {
    expect(shouldRotate({ mtimeMs: now - 60_000, size: 1024 }, now)).toBe(
      false,
    );
  });

  test("previous-day file rotates", () => {
    expect(shouldRotate({ mtimeMs: now - DAY_MS, size: 1024 }, now)).toBe(
      true,
    );
  });

  test("same-day file over the size cap rotates", () => {
    expect(shouldRotate({ mtimeMs: now - 60_000, size: 200 }, now, 100)).toBe(
      true,
    );
  });
});

describe("factory rotation behavior", () => {
  let previousMimirHome: string | undefined;
  let sandbox: string;

  beforeAll(() => {
    previousMimirHome = process.env.MIMIR_HOME;
    sandbox = mkdtempSync(join(tmpdir(), "mimir-logger-test-"));
    process.env.MIMIR_HOME = sandbox;
  });

  afterAll(() => {
    if (previousMimirHome === undefined) delete process.env.MIMIR_HOME;
    else process.env.MIMIR_HOME = previousMimirHome;
    rmSync(sandbox, { recursive: true, force: true });
  });

  test("same-day factories append to one file instead of rotating each other away", async () => {
    // Two factory instances simulate two hook processes in one session.
    const first = createLoggerFactory("rotation-test.log");
    first.createLogger("hook-a").info("first process line");
    await first.flushLogs();

    const second = createLoggerFactory("rotation-test.log");
    second.createLogger("hook-b").info("second process line");
    await second.flushLogs();

    const text = await Bun.file(
      join(sandbox, "logs", "rotation-test.log"),
    ).text();
    expect(text).toContain("first process line");
    expect(text).toContain("second process line");
  });
});
