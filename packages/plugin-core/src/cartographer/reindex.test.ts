import { describe, expect, test } from "bun:test";
import type { Logger } from "../logger";
import type { CartographerClient, ParsedFileOutput } from "./client";
import { reindexFile, reindexProject } from "./reindex";
import type { SyncMode } from "./sync";

const PROJECT = "/repo/project";
const BINARY = "/bin/cartographer";

const log: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const parsedFor = (filePath: string): ParsedFileOutput => ({
  file_path: filePath,
  language: "typescript",
  imports: [],
  symbols: [],
});

type ParseBehaviour = "ok" | "reject" | "empty";

/** A fake client whose parseFile answers per path; records calls and kills. */
const fakeClient = (behaviour: Record<string, ParseBehaviour>) => {
  const parseCalls: [string, string][] = [];
  let kills = 0;
  const client: CartographerClient = {
    callTool: async () => "",
    parseFile: async (project, filePath) => {
      parseCalls.push([project, filePath]);
      const mode = behaviour[filePath] ?? "ok";
      if (mode === "reject") throw new Error(`parse failed: ${filePath}`);
      if (mode === "empty") {
        // The contract says a parseFile resolving nothing is skipped;
        // the real client's type cannot express that, so the fake
        // crosses the boundary the way a bad binary response would.
        return JSON.parse("null");
      }
      return parsedFor(filePath);
    },
    isAlive: () => true,
    kill: () => {
      kills += 1;
    },
  };
  return { client, parseCalls, kills: () => kills };
};

type SyncCall = {
  projectPath: string;
  parsed: readonly ParsedFileOutput[];
  mode: SyncMode;
};

const recordingSync = (
  result: () => Promise<{ ok: true } | { ok: false; error: string }>,
) => {
  const calls: SyncCall[] = [];
  const syncIndex = async (
    projectPath: string,
    parsed: readonly ParsedFileOutput[],
    mode: SyncMode,
  ) => {
    calls.push({ projectPath, parsed, mode });
    return result();
  };
  return { syncIndex, calls };
};

const syncOk = () => recordingSync(async () => ({ ok: true }));

describe("reindexProject", () => {
  test("unconfigured when no binary: nothing listed, nothing spawned", async () => {
    let listed = 0;
    let spawned = 0;
    const sync = syncOk();
    const outcome = await reindexProject(
      { projectPath: PROJECT, cartographerBinary: undefined, log },
      {
        listFiles: async () => {
          listed += 1;
          return ["a.ts"];
        },
        spawnCartographer: async () => {
          spawned += 1;
          return fakeClient({}).client;
        },
        syncIndex: sync.syncIndex,
      },
    );
    expect(outcome.status).toBe("unconfigured");
    expect(listed).toBe(0);
    expect(spawned).toBe(0);
    expect(sync.calls).toHaveLength(0);
  });

  test("no-files when the listing is empty: nothing spawned", async () => {
    let spawned = 0;
    const sync = syncOk();
    const outcome = await reindexProject(
      { projectPath: PROJECT, cartographerBinary: BINARY, log },
      {
        listFiles: async () => [],
        spawnCartographer: async () => {
          spawned += 1;
          return fakeClient({}).client;
        },
        syncIndex: sync.syncIndex,
      },
    );
    expect(outcome.status).toBe("no-files");
    expect(spawned).toBe(0);
    expect(sync.calls).toHaveLength(0);
  });

  test("spawn-failed carries the error message when spawning rejects", async () => {
    const sync = syncOk();
    const outcome = await reindexProject(
      { projectPath: PROJECT, cartographerBinary: BINARY, log },
      {
        listFiles: async () => ["a.ts"],
        spawnCartographer: async () => {
          throw new Error("binary exploded");
        },
        syncIndex: sync.syncIndex,
      },
    );
    expect(outcome.status).toBe("spawn-failed");
    if (outcome.status !== "spawn-failed") return;
    expect(typeof outcome.error).toBe("string");
    expect(outcome.error).toContain("binary exploded");
    expect(sync.calls).toHaveLength(0);
  });

  test("spawns the given binary against the project path", async () => {
    const spawnCalls: [string, string][] = [];
    const fake = fakeClient({});
    await reindexProject(
      { projectPath: PROJECT, cartographerBinary: BINARY, log },
      {
        listFiles: async () => ["a.ts"],
        spawnCartographer: async (binary, projectPath) => {
          spawnCalls.push([binary, projectPath]);
          return fake.client;
        },
        syncIndex: syncOk().syncIndex,
      },
    );
    expect(spawnCalls).toEqual([[BINARY, PROJECT]]);
  });

  test("nothing-parsed when every file fails or resolves nothing; syncIndex not called", async () => {
    const fake = fakeClient({ "a.ts": "reject", "b.ts": "empty" });
    const sync = syncOk();
    const outcome = await reindexProject(
      { projectPath: PROJECT, cartographerBinary: BINARY, log },
      {
        listFiles: async () => ["a.ts", "b.ts"],
        spawnCartographer: async () => fake.client,
        syncIndex: sync.syncIndex,
      },
    );
    expect(outcome.status).toBe("nothing-parsed");
    if (outcome.status !== "nothing-parsed") return;
    expect(outcome.attempted).toBe(2);
    expect(outcome.parseFailures).toBe(1);
    expect(sync.calls).toHaveLength(0);
    expect(fake.kills()).toBe(1);
  });

  test("synced: parses each listed path, skips failures and empties, replaces the index once", async () => {
    const fake = fakeClient({ "b.ts": "reject", "c.ts": "empty" });
    const sync = syncOk();
    const outcome = await reindexProject(
      { projectPath: PROJECT, cartographerBinary: BINARY, log },
      {
        listFiles: async () => ["a.ts", "b.ts", "c.ts", "src/d.ts"],
        spawnCartographer: async () => fake.client,
        syncIndex: sync.syncIndex,
      },
    );
    expect(outcome).toEqual({
      status: "synced",
      attempted: 4,
      parsed: 2,
      parseFailures: 1,
      syncOk: true,
    });
    expect(fake.parseCalls).toEqual([
      [PROJECT, "a.ts"],
      [PROJECT, "b.ts"],
      [PROJECT, "c.ts"],
      [PROJECT, "src/d.ts"],
    ]);
    expect(sync.calls).toHaveLength(1);
    expect(sync.calls[0]?.projectPath).toBe(PROJECT);
    expect(sync.calls[0]?.mode).toBe("replace");
    expect(sync.calls[0]?.parsed.map((p) => p.file_path)).toEqual([
      "a.ts",
      "src/d.ts",
    ]);
    expect(fake.kills()).toBe(1);
  });

  test("syncIndex resolving ok:false gives synced with syncOk false", async () => {
    const fake = fakeClient({});
    const sync = recordingSync(async () => ({ ok: false, error: "db locked" }));
    const outcome = await reindexProject(
      { projectPath: PROJECT, cartographerBinary: BINARY, log },
      {
        listFiles: async () => ["a.ts"],
        spawnCartographer: async () => fake.client,
        syncIndex: sync.syncIndex,
      },
    );
    expect(outcome.status).toBe("synced");
    if (outcome.status !== "synced") return;
    expect(outcome.syncOk).toBe(false);
    expect(fake.kills()).toBe(1);
  });

  test("syncIndex rejecting gives synced with syncOk false and does not throw", async () => {
    const fake = fakeClient({});
    const sync = recordingSync(async () => {
      throw new Error("disk gone");
    });
    const outcome = await reindexProject(
      { projectPath: PROJECT, cartographerBinary: BINARY, log },
      {
        listFiles: async () => ["a.ts"],
        spawnCartographer: async () => fake.client,
        syncIndex: sync.syncIndex,
      },
    );
    expect(outcome.status).toBe("synced");
    if (outcome.status !== "synced") return;
    expect(outcome.syncOk).toBe(false);
    expect(fake.kills()).toBe(1);
  });
});

describe("reindexFile", () => {
  const FILE = "src/changed.ts";

  test("unconfigured when no binary: nothing spawned", async () => {
    let spawned = 0;
    const sync = syncOk();
    const outcome = await reindexFile(
      {
        projectPath: PROJECT,
        filePath: FILE,
        cartographerBinary: undefined,
        log,
      },
      {
        spawnCartographer: async () => {
          spawned += 1;
          return fakeClient({}).client;
        },
        syncIndex: sync.syncIndex,
      },
    );
    expect(outcome.status).toBe("unconfigured");
    expect(spawned).toBe(0);
    expect(sync.calls).toHaveLength(0);
  });

  test("spawn-failed carries the error message", async () => {
    const outcome = await reindexFile(
      { projectPath: PROJECT, filePath: FILE, cartographerBinary: BINARY, log },
      {
        spawnCartographer: async () => {
          throw new Error("no such binary");
        },
        syncIndex: syncOk().syncIndex,
      },
    );
    expect(outcome.status).toBe("spawn-failed");
    if (outcome.status !== "spawn-failed") return;
    expect(outcome.error).toContain("no such binary");
  });

  test("parse-failed when parseFile rejects; syncIndex not called", async () => {
    const fake = fakeClient({ [FILE]: "reject" });
    const sync = syncOk();
    const outcome = await reindexFile(
      { projectPath: PROJECT, filePath: FILE, cartographerBinary: BINARY, log },
      { spawnCartographer: async () => fake.client, syncIndex: sync.syncIndex },
    );
    expect(outcome.status).toBe("parse-failed");
    expect(sync.calls).toHaveLength(0);
    expect(fake.kills()).toBe(1);
  });

  test("parse-failed when parseFile resolves nothing; syncIndex not called", async () => {
    const fake = fakeClient({ [FILE]: "empty" });
    const sync = syncOk();
    const outcome = await reindexFile(
      { projectPath: PROJECT, filePath: FILE, cartographerBinary: BINARY, log },
      { spawnCartographer: async () => fake.client, syncIndex: sync.syncIndex },
    );
    expect(outcome.status).toBe("parse-failed");
    expect(sync.calls).toHaveLength(0);
    expect(fake.kills()).toBe(1);
  });

  test("synced: parses the path as given and upserts it", async () => {
    const fake = fakeClient({});
    const sync = syncOk();
    const outcome = await reindexFile(
      { projectPath: PROJECT, filePath: FILE, cartographerBinary: BINARY, log },
      { spawnCartographer: async () => fake.client, syncIndex: sync.syncIndex },
    );
    expect(outcome).toEqual({ status: "synced", syncOk: true });
    expect(fake.parseCalls).toEqual([[PROJECT, FILE]]);
    expect(sync.calls).toEqual([
      { projectPath: PROJECT, parsed: [parsedFor(FILE)], mode: "upsert" },
    ]);
    expect(fake.kills()).toBe(1);
  });

  test("syncIndex failing gives synced with syncOk false and does not throw", async () => {
    const failures = [
      recordingSync(async () => ({ ok: false, error: "db locked" })),
      recordingSync(async () => {
        throw new Error("disk gone");
      }),
    ];
    for (const sync of failures) {
      const fake = fakeClient({});
      const outcome = await reindexFile(
        {
          projectPath: PROJECT,
          filePath: FILE,
          cartographerBinary: BINARY,
          log,
        },
        {
          spawnCartographer: async () => fake.client,
          syncIndex: sync.syncIndex,
        },
      );
      expect(outcome).toEqual({ status: "synced", syncOk: false });
      expect(fake.kills()).toBe(1);
    }
  });
});
