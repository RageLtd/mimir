import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearSummaryPending,
  isSummaryPending,
  markSummaryPending,
  SUMMARY_PENDING_STALE_MS,
} from "./summary-pending";

let home: string;
let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env.MIMIR_HOME;
  home = await mkdtemp(join(tmpdir(), "mimir-summary-pending-"));
  process.env.MIMIR_HOME = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

const NOW = 1_000_000_000;
const PROJECT = "project:abc";
const OTHER = "project:other";
const NO_SUCH_OWNER = "not-an-owner";

const filesUnderHome = () =>
  Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: home, onlyFiles: true }));

describe("summary pending", () => {
  test("the stale window is five minutes", () => {
    expect(SUMMARY_PENDING_STALE_MS).toBe(5 * 60_000);
  });

  test("a project with no mark is not pending", async () => {
    expect(await isSummaryPending(PROJECT, NOW)).toBe(false);
  });

  test("marking resolves to an owner token, different on each call", async () => {
    const first = await markSummaryPending(PROJECT, NOW);
    const second = await markSummaryPending(PROJECT, NOW);
    expect(typeof first).toBe("string");
    expect(typeof second).toBe("string");
    expect(String(first).length).toBeGreaterThan(0);
    expect(String(second).length).toBeGreaterThan(0);
    expect(second).not.toBe(first);
  });

  test("a mark is pending until its owner clears it", async () => {
    const token = await markSummaryPending(PROJECT, NOW);
    expect(await isSummaryPending(PROJECT, NOW)).toBe(true);
    await clearSummaryPending(PROJECT, token);
    expect(await isSummaryPending(PROJECT, NOW)).toBe(false);
  });

  test("another worker's token leaves the mark in place", async () => {
    await markSummaryPending(PROJECT, NOW);
    await clearSummaryPending(PROJECT, NO_SUCH_OWNER);
    expect(await isSummaryPending(PROJECT, NOW)).toBe(true);
  });

  test("a second mark takes ownership: the first owner's clear is a no-op, the newest owner's clears", async () => {
    const first = await markSummaryPending(PROJECT, NOW);
    const second = await markSummaryPending(PROJECT, NOW);

    await clearSummaryPending(PROJECT, first);
    expect(await isSummaryPending(PROJECT, NOW)).toBe(true);

    await clearSummaryPending(PROJECT, second);
    expect(await isSummaryPending(PROJECT, NOW)).toBe(false);
  });

  test("clearing a mark that does not exist is not an error", async () => {
    await clearSummaryPending(PROJECT, NO_SUCH_OWNER);
    expect(await isSummaryPending(PROJECT, NOW)).toBe(false);
  });

  test("a mark older than the stale window reads as not pending", async () => {
    await markSummaryPending(PROJECT, NOW);
    expect(
      await isSummaryPending(PROJECT, NOW + SUMMARY_PENDING_STALE_MS - 1),
    ).toBe(true);
    expect(
      await isSummaryPending(PROJECT, NOW + SUMMARY_PENDING_STALE_MS + 1),
    ).toBe(false);
  });

  test("marks are per project", async () => {
    const token = await markSummaryPending(PROJECT, NOW);
    expect(await isSummaryPending(OTHER, NOW)).toBe(false);
    await clearSummaryPending(OTHER, token);
    expect(await isSummaryPending(PROJECT, NOW)).toBe(true);
  });

  test("project ids with ':' or '/' are safe as file names", async () => {
    const nested = "project:a/b";
    const parent = "project:a";
    await markSummaryPending(nested, NOW);
    expect(await isSummaryPending(nested, NOW)).toBe(true);
    expect(await isSummaryPending(parent, NOW)).toBe(false);

    const parentToken = await markSummaryPending(parent, NOW);
    await clearSummaryPending(parent, parentToken);
    expect(await isSummaryPending(nested, NOW)).toBe(true);

    await markSummaryPending("../escape", NOW);
    expect(await isSummaryPending("../escape", NOW)).toBe(true);
    expect(await Bun.file(join(home, "..", "escape")).exists()).toBe(false);
    expect(await Bun.file(join(home, "..", "escape.json")).exists()).toBe(
      false,
    );
  });

  test("a corrupt mark file reads as not pending rather than throwing", async () => {
    await markSummaryPending(PROJECT, NOW);
    const files = await filesUnderHome();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) await Bun.write(join(home, file), "not json {");
    expect(await isSummaryPending(PROJECT, NOW)).toBe(false);
  });

  test("clearing a corrupt mark with any token does not throw", async () => {
    await markSummaryPending(PROJECT, NOW);
    for (const file of await filesUnderHome())
      await Bun.write(join(home, file), "not json {");
    await clearSummaryPending(PROJECT, NO_SUCH_OWNER);
    expect(await isSummaryPending(PROJECT, NOW)).toBe(false);
  });
});
