import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSummary } from "@mimir/plugin-core/brain/summarize";
import {
  _extractionWatermarks,
  _summaryWatermarks,
  type convertMessage,
  distillBeforeCompaction,
} from "./transcript-persistence";

const cleanup: (() => void)[] = [];
afterEach(() => {
  _extractionWatermarks.clear();
  _summaryWatermarks.clear();
  for (const close of cleanup.splice(0)) close();
});

const log = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
const config = {
  serverUrl: "http://localhost",
  apiKey: "key",
  userMemoryDb: ":memory:",
};
const REPLICA_ENV = "MIMIR_ORG_REPLICA_DB";
/** A run that distils opens the replica: point it away from the live one. */
const useScratchReplica = () => {
  const dir = mkdtempSync(join(tmpdir(), "mimir-oc-compaction-test-"));
  const previous = process.env[REPLICA_ENV];
  process.env[REPLICA_ENV] = join(dir, "replica.db");
  cleanup.push(() => {
    if (previous === undefined) delete process.env[REPLICA_ENV];
    else process.env[REPLICA_ENV] = previous;
    rmSync(dir, { recursive: true, force: true });
  });
};
const extracted = { ok: true as const, memories: [], skipped: null };

/** Well over the summary floor on its own. */
const LONG =
  "A substantive design discussion about the replica sync path. ".repeat(10);
type ContextRecord = Parameters<typeof convertMessage>[0];
const user = (id: string, text: string = id) =>
  ({ type: "user", id, text }) satisfies ContextRecord;
const asModel = (records: readonly { text: string }[]) =>
  records.map((record) => ({ role: "user", content: record.text.trim() }));
const contextOf = (records: ContextRecord[]) => ({
  session: { context: async () => records },
});

/** A summariser that gates like the real one (prepareSummary's floor). */
const windowed = () => {
  const mode = { fail: false };
  const seen = {
    summarized: [] as unknown[],
    stored: [] as string[],
    extracted: [] as unknown[],
    syncs: 0,
    configs: 0,
  };
  const ops = {
    extractionConfig: async () => {
      seen.configs++;
      return { baseUrl: "http://unused", model: "test" };
    },
    summarizeToReplica: async (opts) => {
      seen.summarized.push(opts.messages);
      if (mode.fail) return { ok: false, id: null, skipped: null };
      const prepared = prepareSummary(opts.messages);
      if ("skipped" in prepared) {
        return { ok: true, id: null, skipped: prepared.skipped };
      }
      const id = `memory:summary-${seen.stored.length + 1}`;
      seen.stored.push(id);
      return { ok: true, id, skipped: null };
    },
    extractFromConversation: async (_config, messages) => {
      seen.extracted.push(messages);
      return extracted;
    },
    syncAfterDistill: async () => {
      seen.syncs++;
    },
  } satisfies NonNullable<Parameters<typeof distillBeforeCompaction>[5]>;
  return { mode, seen, ops };
};

describe("distillBeforeCompaction — summary from the whole window, facts from the delta", () => {
  test("a tiny delta in a large window: the summary reads the whole window, facts the delta alone", async () => {
    useScratchReplica();
    const records = [
      user("u1", LONG),
      user("u2", LONG),
      user("u3", "a short follow-up"),
    ];
    _extractionWatermarks.set("s", "u2");
    const { seen, ops } = windowed();

    await distillBeforeCompaction(
      "s",
      "/repo",
      config,
      log,
      contextOf(records),
      ops,
    );

    expect(seen.summarized).toEqual([asModel(records)]);
    expect(seen.stored).toEqual(["memory:summary-1"]);
    expect(seen.extracted).toEqual([
      [{ role: "user", content: "a short follow-up" }],
    ]);
    expect(seen.syncs).toBe(1);
    expect(_extractionWatermarks.get("s")).toBe("u3");
  });

  test("idle extraction caught up: the window is still summarised, and no facts are read from the empty delta", async () => {
    useScratchReplica();
    const records = [user("u1", LONG), user("u2", LONG)];
    _extractionWatermarks.set("s", "u2");
    const { seen, ops } = windowed();

    await distillBeforeCompaction(
      "s",
      "/repo",
      config,
      log,
      contextOf(records),
      ops,
    );

    expect(seen.summarized).toEqual([asModel(records)]);
    expect(seen.stored).toEqual(["memory:summary-1"]);
    expect(seen.extracted).toEqual([]);
    expect(seen.syncs).toBe(1);
    expect(_extractionWatermarks.get("s")).toBe("u2");
  });

  test("a window under the summary floor stores no summary; the delta's facts are still read and the watermark advances", async () => {
    useScratchReplica();
    const records = [user("u1", "first prompt"), user("u2", "second prompt")];
    _extractionWatermarks.set("s", "u1");
    const { seen, ops } = windowed();

    await distillBeforeCompaction(
      "s",
      "/repo",
      config,
      log,
      contextOf(records),
      ops,
    );

    expect(seen.stored).toEqual([]);
    expect(seen.extracted).toEqual([
      [{ role: "user", content: "second prompt" }],
    ]);
    expect(seen.syncs).toBe(0);
    expect(_extractionWatermarks.get("s")).toBe("u2");
  });

  test("an empty delta in a window under the floor stores nothing and does not sync", async () => {
    useScratchReplica();
    const records = [user("u1", "first prompt")];
    _extractionWatermarks.set("s", "u1");
    const { seen, ops } = windowed();

    await distillBeforeCompaction(
      "s",
      "/repo",
      config,
      log,
      contextOf(records),
      ops,
    );

    expect(seen.stored).toEqual([]);
    expect(seen.extracted).toEqual([]);
    expect(seen.syncs).toBe(0);
    expect(_extractionWatermarks.get("s")).toBe("u1");
  });

  test("a failed summary keeps the watermark and reads no facts", async () => {
    useScratchReplica();
    const records = [user("u1", LONG), user("u2", LONG)];
    _extractionWatermarks.set("s", "u1");
    const { mode, seen, ops } = windowed();
    mode.fail = true;

    await distillBeforeCompaction(
      "s",
      "/repo",
      config,
      log,
      contextOf(records),
      ops,
    );

    expect(seen.summarized).toEqual([asModel(records)]);
    expect(seen.extracted).toEqual([]);
    expect(seen.syncs).toBe(0);
    expect(_extractionWatermarks.get("s")).toBe("u1");
  });

  test("an unchanged window is summarised once; new messages earn a second summary", async () => {
    useScratchReplica();
    const records = [user("u1", LONG), user("u2", LONG)];
    _extractionWatermarks.set("s", "u2");
    const { seen, ops } = windowed();
    const client = contextOf(records);

    await distillBeforeCompaction("s", "/repo", config, log, client, ops);
    await distillBeforeCompaction("s", "/repo", config, log, client, ops);

    expect(seen.summarized).toHaveLength(1);
    expect(seen.stored).toEqual(["memory:summary-1"]);
    expect(seen.syncs).toBe(1);

    records.push(user("u3", "a new turn"));
    await distillBeforeCompaction("s", "/repo", config, log, client, ops);

    expect(seen.summarized).toHaveLength(2);
    expect(seen.summarized[1]).toEqual(asModel(records));
    expect(seen.stored).toEqual(["memory:summary-1", "memory:summary-2"]);
    expect(seen.extracted).toEqual([[{ role: "user", content: "a new turn" }]]);
    expect(seen.syncs).toBe(2);
  });

  test("a failed summary does not count as summarised: the same window is retried", async () => {
    useScratchReplica();
    const records = [user("u1", LONG), user("u2", LONG)];
    _extractionWatermarks.set("s", "u2");
    const { mode, seen, ops } = windowed();
    const client = contextOf(records);

    mode.fail = true;
    await distillBeforeCompaction("s", "/repo", config, log, client, ops);
    mode.fail = false;
    await distillBeforeCompaction("s", "/repo", config, log, client, ops);

    expect(seen.summarized).toHaveLength(2);
    expect(seen.stored).toEqual(["memory:summary-1"]);
    expect(seen.syncs).toBe(1);
  });

  test("after a stored summary, a compaction whose only new records are auxiliary stores no second summary", async () => {
    useScratchReplica();
    const records: ContextRecord[] = [user("u1", LONG), user("u2", LONG)];
    _extractionWatermarks.set("s", "u2");
    const { seen, ops } = windowed();
    const client = contextOf(records);

    await distillBeforeCompaction("s", "/repo", config, log, client, ops);
    expect(seen.stored).toEqual(["memory:summary-1"]);

    // convertMessage turns both into nothing: a bare compaction marker and
    // an assistant turn of reasoning alone.
    records.push(
      { id: "x1", type: "compaction" },
      {
        id: "x2",
        type: "assistant",
        content: [{ type: "reasoning", text: "thinking it over" }],
      },
    );
    await distillBeforeCompaction("s", "/repo", config, log, client, ops);

    expect(seen.summarized).toHaveLength(1);
    expect(seen.stored).toEqual(["memory:summary-1"]);
    expect(seen.extracted).toEqual([]);
    expect(seen.syncs).toBe(1);
  });

  test("a window under the floor with an empty delta resolves no endpoint and opens no store", async () => {
    // The replica path is observable: opening the store creates the file.
    const dir = mkdtempSync(join(tmpdir(), "mimir-oc-compaction-noop-"));
    const replicaPath = join(dir, "replica.db");
    const previous = process.env[REPLICA_ENV];
    process.env[REPLICA_ENV] = replicaPath;
    cleanup.push(() => {
      if (previous === undefined) delete process.env[REPLICA_ENV];
      else process.env[REPLICA_ENV] = previous;
      rmSync(dir, { recursive: true, force: true });
    });
    const records = [user("u1", "first prompt")];
    _extractionWatermarks.set("s", "u1");
    const { seen, ops } = windowed();

    await distillBeforeCompaction(
      "s",
      "/repo",
      config,
      log,
      contextOf(records),
      ops,
    );

    expect(seen.configs).toBe(0);
    expect(seen.summarized).toEqual([]);
    expect(seen.extracted).toEqual([]);
    expect(seen.syncs).toBe(0);
    expect(existsSync(replicaPath)).toBe(false);
  });
});
