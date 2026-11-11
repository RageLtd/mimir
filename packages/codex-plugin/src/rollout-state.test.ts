import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readSummaryState,
  readWatermark,
  writeState,
  writeSummaryState,
  writeWatermark,
} from "./rollout-delta";

// State writes land under mimirHome() — isolate the suite.
let previousMimirHome: string | undefined;
let home: string;

beforeAll(() => {
  previousMimirHome = process.env.MIMIR_HOME;
  home = mkdtempSync(join(tmpdir(), "mimir-codex-state-test-"));
  process.env.MIMIR_HOME = home;
});

afterAll(() => {
  if (previousMimirHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = previousMimirHome;
  rmSync(home, { recursive: true, force: true });
});

const stateFile = (sessionId: string) =>
  join(home, "persist-state", `${sessionId}.json`);

describe("writeState — the watermark and summary state in one write", () => {
  test("writes every field it is given in one file", async () => {
    await writeState("codex-state-a", {
      offset: 12,
      summarizedThrough: 9,
      summaryId: "memory:summary-a",
    });

    expect(await Bun.file(stateFile("codex-state-a")).json()).toEqual({
      offset: 12,
      summarizedThrough: 9,
      summaryId: "memory:summary-a",
    });
    expect(await readWatermark("codex-state-a")).toBe(12);
    expect(await readSummaryState("codex-state-a")).toEqual({
      summarizedThrough: 9,
      summaryId: "memory:summary-a",
    });
  });

  test("absent fields keep their stored values", async () => {
    await writeState("codex-state-b", {
      offset: 4,
      summarizedThrough: 3,
      summaryId: "memory:summary-b",
    });

    await writeState("codex-state-b", { offset: 8 });
    expect(await Bun.file(stateFile("codex-state-b")).json()).toEqual({
      offset: 8,
      summarizedThrough: 3,
      summaryId: "memory:summary-b",
    });

    await writeState("codex-state-b", {
      summarizedThrough: 7,
      summaryId: "memory:summary-b2",
    });
    expect(await Bun.file(stateFile("codex-state-b")).json()).toEqual({
      offset: 8,
      summarizedThrough: 7,
      summaryId: "memory:summary-b2",
    });
  });

  test("the single-purpose writers still write their own fields", async () => {
    await writeWatermark("codex-state-c", 5);
    await writeSummaryState("codex-state-c", {
      summarizedThrough: 4,
      summaryId: "memory:summary-c",
    });

    expect(await Bun.file(stateFile("codex-state-c")).json()).toEqual({
      offset: 5,
      summarizedThrough: 4,
      summaryId: "memory:summary-c",
    });
    expect(readdirSync(join(home, "persist-state")).sort()).toEqual(
      ["codex-state-a.json", "codex-state-b.json", "codex-state-c.json"].sort(),
    );
  });
});
