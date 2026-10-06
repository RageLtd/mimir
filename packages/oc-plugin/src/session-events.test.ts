import { afterEach, describe, expect, test } from "bun:test";
import { createEventHandler } from "./session-events";
import { _extractionWatermarks } from "./transcript-persistence";
import { createSessionRoles, type SessionInfo } from "./worker-hooks";

afterEach(() => _extractionWatermarks.clear());

const fixture = (directory = "/repo", projectPath?: string) => {
  const calls: string[] = [];
  const paths: string[] = [];
  const sessions: Record<string, SessionInfo> = {
    main: {},
    child: { parentID: "main", agent: "mimir-impl" },
  };
  const roles = createSessionRoles(async (id) => sessions[id] ?? null);
  const handler = createEventHandler(
    {
      directory,
      projectPath,
      config: { serverUrl: "http://localhost", userMemoryDb: ":memory:" },
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (message) => {
          calls.push(message);
        },
      },
      client: { session: { context: async () => [] } },
      sessionRoles: roles,
    },
    {
      runReindexWorker: async (_log, _config, project, file) => {
        paths.push(project);
        calls.push(`file:${file}`);
      },
      runFullReindex: async (_log, _config, project) => {
        paths.push(project);
        calls.push("full");
      },
      reconcileFromSharedConfig: async () => {
        calls.push("keys");
        return { status: "skipped", detail: undefined };
      },
      syncFromSharedConfig: async () => {
        calls.push("sync");
        return { status: "skipped", detail: undefined };
      },
      persistSessionTranscript: async (id, project) => {
        paths.push(project);
        calls.push(`persist:${id}`);
      },
    },
  );
  const event = async (
    type: string,
    data: unknown,
    eventDirectory = directory,
  ) => {
    await handler({ type, data, location: { directory: eventDirectory } });
    // Fire-and-forget continuations finish without timers or external work.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { calls, paths, sessions, roles, handler, event };
};

describe("V2 session event handler", () => {
  test("filters nested location events but attributes work to the project root", async () => {
    const f = fixture("/repo/packages/api", "/repo");
    await f.event("filesystem.changed", { file: "/repo/packages/api/a.ts" });
    await f.event("filesystem.changed", { file: "/other/a.ts" }, "/other");
    await f.event("session.created", { sessionID: "main" });
    await f.event("session.idle", { sessionID: "main" });
    expect(f.calls).toEqual([
      "file:/repo/packages/api/a.ts",
      "full",
      "keys",
      "sync",
      "persist:main",
      "sync",
    ]);
    expect(f.paths).toEqual(["/repo", "/repo", "/repo"]);
  });
  test("reindexes filesystem.changed data.file only for this directory", async () => {
    const f = fixture();
    await f.event("filesystem.changed", { file: "/repo/a.ts" });
    await f.event("filesystem.changed", { file: "/other/b.ts" }, "/other");
    await f.handler({ type: "filesystem.changed", data: { file: "unscoped" } });
    expect(f.calls).toEqual(["file:/repo/a.ts"]);
  });

  test("created and idle main sessions run lifecycle work; children do neither", async () => {
    const f = fixture();
    await f.event("session.created", { sessionID: "child" });
    await f.event("session.idle", { sessionID: "child" });
    expect(f.calls).toEqual([]);
    await f.event("session.created", { sessionID: "main" });
    expect(f.calls).toEqual(["full", "keys", "sync"]);
    await f.event("session.idle", { sessionID: "main" });
    expect(f.calls).toEqual(["full", "keys", "sync", "persist:main", "sync"]);
    await f.event("session.idle", { sessionID: "main" }, "/other");
    expect(f.calls).toHaveLength(5);
  });

  test("agent selection invalidates roles and deletion also removes watermark", async () => {
    const f = fixture();
    expect(await f.roles.workerRole("child")).toBe("impl");
    f.sessions.child = { parentID: "main", agent: "mimir-test" };
    await f.event("session.agent.selected", {
      sessionID: "child",
      agent: "mimir-test",
    });
    expect(await f.roles.workerRole("child")).toBe("test");
    _extractionWatermarks.set("child", "msg-last");
    delete f.sessions.child;
    await f.event("session.deleted", { sessionID: "child" });
    expect(await f.roles.isChild("child")).toBe(false);
    expect(_extractionWatermarks.has("child")).toBe(false);
  });
});
