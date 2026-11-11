import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearInjectedIds,
  readInjectedIds,
  recordInjectedIds,
} from "./retrieve-state";

let home: string;
let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env.MIMIR_HOME;
  home = await mkdtemp(join(tmpdir(), "mimir-retrieve-state-"));
  process.env.MIMIR_HOME = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

const stateFile = (sessionId: string) =>
  Bun.file(join(home, "retrieve-state", `${sessionId}.json`));

describe("retrieve state", () => {
  test("a session that has injected nothing has an empty set", async () => {
    expect(await readInjectedIds("s1")).toEqual(new Set());
  });

  test("recorded ids accumulate without duplicates", async () => {
    await recordInjectedIds("s1", ["memory:a", "memory:b"]);
    await recordInjectedIds("s1", ["memory:b", "memory:c"]);
    expect(await readInjectedIds("s1")).toEqual(
      new Set(["memory:a", "memory:b", "memory:c"]),
    );
  });

  test("sessions do not share ids", async () => {
    await recordInjectedIds("s1", ["memory:a"]);
    expect(await readInjectedIds("s2")).toEqual(new Set());
  });

  test("recording nothing writes nothing", async () => {
    await recordInjectedIds("s1", []);
    expect(await stateFile("s1").exists()).toBe(false);
  });

  test("a clear empties the list", async () => {
    await recordInjectedIds("s1", ["memory:a"]);
    await clearInjectedIds("s1");
    expect(await readInjectedIds("s1")).toEqual(new Set());
  });

  test("a clear with no state file creates none", async () => {
    await clearInjectedIds("s1");
    expect(await stateFile("s1").exists()).toBe(false);
  });

  test("a write leaves no partial file behind", async () => {
    await recordInjectedIds("s1", ["memory:a"]);
    const names = await Array.fromAsync(
      new Bun.Glob("*").scan({ cwd: join(home, "retrieve-state") }),
    );
    expect(names).toEqual(["s1.json"]);
  });

  test("a file that cannot be parsed fails the read and is repaired by the next write", async () => {
    await recordInjectedIds("s1", ["memory:a"]);
    await Bun.write(stateFile("s1"), '{"injected": ["memo');
    await expect(readInjectedIds("s1")).rejects.toThrow();
    await recordInjectedIds("s1", ["memory:b"]);
    expect(await readInjectedIds("s1")).toEqual(new Set(["memory:b"]));
  });

  test("a clear repairs a file that cannot be parsed", async () => {
    await recordInjectedIds("s1", ["memory:a"]);
    await Bun.write(stateFile("s1"), "not json");
    await clearInjectedIds("s1");
    expect(await readInjectedIds("s1")).toEqual(new Set());
  });

  test("another writer's keys in the file survive a record and a clear", async () => {
    // Codex's first-prompt marker lives in the same file.
    await recordInjectedIds("s1", ["memory:a"]);
    const file = stateFile("s1");
    await Bun.write(
      file,
      JSON.stringify({ initialized: 42, injected: ["memory:a"] }),
    );
    await recordInjectedIds("s1", ["memory:b"]);
    expect(await file.json()).toEqual({
      initialized: 42,
      injected: ["memory:a", "memory:b"],
    });
    await clearInjectedIds("s1");
    expect(await file.json()).toEqual({ initialized: 42, injected: [] });
  });

  test("a session id that is not a plain name is refused", async () => {
    const refused = "cannot name a retrieve-state file";
    await expect(recordInjectedIds("../escape", ["memory:a"])).rejects.toThrow(
      refused,
    );
    await expect(clearInjectedIds("../escape")).rejects.toThrow(refused);
    await expect(readInjectedIds("../escape")).rejects.toThrow(refused);
    await expect(readInjectedIds("a.b")).rejects.toThrow(refused);
    expect(await Bun.file(join(home, "escape.json")).exists()).toBe(false);
  });
});
