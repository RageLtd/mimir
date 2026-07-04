import { describe, expect, test } from "bun:test";
import { filterLogLines, parseSince, readLogTail } from "./introspection";

const NOW = Date.parse("2026-07-04T00:00:00Z");

const pinoLine = (timeMs: number, msg: string) =>
  JSON.stringify({ level: 30, time: timeMs, msg });

describe("parseSince", () => {
  test("docker-style durations", () => {
    expect(parseSince("30s", NOW)).toBe(NOW - 30_000);
    expect(parseSince("10m", NOW)).toBe(NOW - 600_000);
    expect(parseSince("2h", NOW)).toBe(NOW - 7_200_000);
    expect(parseSince("1d", NOW)).toBe(NOW - 86_400_000);
  });

  test("ISO dates pass through Date.parse", () => {
    expect(parseSince("2026-07-03T00:00:00Z", NOW)).toBe(
      Date.parse("2026-07-03T00:00:00Z"),
    );
  });

  test("garbage → null", () => {
    expect(parseSince("yesterday-ish", NOW)).toBeNull();
    expect(parseSince("10x", NOW)).toBeNull();
    expect(parseSince("", NOW)).toBeNull();
  });
});

describe("filterLogLines", () => {
  const lines = [
    pinoLine(NOW - 3_600_000, "old compaction run"),
    pinoLine(NOW - 60_000, "memory retrieval complete"),
    "not json at all",
    pinoLine(NOW - 1_000, "cartographer index synced"),
  ];

  test("no options → passthrough (including non-JSON noise)", () => {
    expect(filterLogLines(lines)).toEqual(lines);
  });

  test("substring filter is case-insensitive", () => {
    const result = filterLogLines(lines, { filter: "MEMORY" });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("memory retrieval");
  });

  test("since cutoff keeps only parseable lines at/after it", () => {
    const result = filterLogLines(lines, { sinceMs: NOW - 120_000 });
    // The hour-old line and the unparseable line both drop — a line whose
    // age is unknowable cannot satisfy a time cutoff.
    expect(result).toHaveLength(2);
    expect(result[0]).toContain("memory retrieval");
    expect(result[1]).toContain("cartographer");
  });

  test("since + filter compose", () => {
    const result = filterLogLines(lines, {
      sinceMs: NOW - 120_000,
      filter: "cartographer",
    });
    expect(result).toHaveLength(1);
  });
});

describe("readLogTail", () => {
  test("missing file → null", async () => {
    expect(await readLogTail("/tmp/mimir-definitely-not-here.log")).toBeNull();
  });

  test("small file → all lines, no partial-line drop", async () => {
    const path = `/tmp/mimir-introspection-test-${Date.now()}.log`;
    await Bun.write(path, `${pinoLine(NOW, "one")}\n${pinoLine(NOW, "two")}\n`);

    const lines = await readLogTail(path);

    expect(lines).toHaveLength(2);
    expect(lines?.[0]).toContain("one");
  });

  test("bounded read drops the leading partial line", async () => {
    const path = `/tmp/mimir-introspection-tail-${Date.now()}.log`;
    const rows = Array.from({ length: 50 }, (_, i) =>
      pinoLine(NOW + i, `entry number ${i} with some padding text`),
    );
    await Bun.write(path, `${rows.join("\n")}\n`);

    // Read a window smaller than the file — the first line in the window is
    // almost certainly cut mid-record and must not surface.
    const lines = await readLogTail(path, 500);

    expect(lines).not.toBeNull();
    expect(lines?.length).toBeGreaterThan(0);
    expect(lines?.length).toBeLessThan(50);
    for (const line of lines ?? []) {
      // Every surfaced line parses cleanly — no truncated JSON.
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(lines?.at(-1)).toContain("entry number 49");
  });
});
