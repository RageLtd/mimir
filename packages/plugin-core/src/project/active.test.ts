import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../logger";
import { activeProjectId } from "./active";

const CWD = "/repo";
const FILE_SERVER = "http://from-file.test";
const FILE_KEY = "file-key";
const GIVEN_SERVER = "http://given.test";
const GIVEN_KEY = "given-key";
const GIVEN_USER_DB = "/u.db";
const GIVEN_CONFIG = { serverUrl: GIVEN_SERVER, userMemoryDb: GIVEN_USER_DB };

let home: string;
const savedHome = process.env.MIMIR_HOME;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mimir-active-"));
  process.env.MIMIR_HOME = home;
});

afterEach(async () => {
  process.env.MIMIR_HOME = savedHome;
  await rm(home, { recursive: true, force: true });
});

const writeConfigFile = () =>
  Bun.write(
    join(home, "config.json"),
    JSON.stringify({
      serverUrl: FILE_SERVER,
      userMemoryDb: join(home, "user.db"),
      apiKey: FILE_KEY,
    }),
  );

const recordingResolver = (answer: () => Promise<string>) => {
  const calls: (string | undefined)[][] = [];
  const resolve = (serverUrl: string, cwd: string, apiKey?: string) => {
    calls.push([serverUrl, cwd, apiKey]);
    return answer();
  };
  return { calls, resolve };
};

const recordingLogger = () => {
  const warnings: unknown[][] = [];
  const log: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message, context) => {
      warnings.push([message, context]);
    },
    error: () => undefined,
  };
  return { warnings, log };
};

const rejecting = (message: string) =>
  recordingResolver(async () => {
    throw new Error(message);
  });

describe("activeProjectId", () => {
  test("with no config at all, resolves null without calling the resolver", async () => {
    const { calls, resolve } = recordingResolver(async () => "project:x");

    expect(await activeProjectId(CWD, { resolve })).toBeNull();
    expect(calls).toEqual([]);
  });

  test("reads the shared config and resolves through it when none is given", async () => {
    await writeConfigFile();
    const { calls, resolve } = recordingResolver(async () => "project:file");

    expect(await activeProjectId(CWD, { resolve })).toBe("project:file");
    expect(calls).toEqual([[FILE_SERVER, CWD, FILE_KEY]]);
  });

  test("a given config is used and the config file is not read", async () => {
    await writeConfigFile();
    const { calls, resolve } = recordingResolver(async () => "project:given");

    const id = await activeProjectId(CWD, {
      config: { ...GIVEN_CONFIG, apiKey: GIVEN_KEY },
      resolve,
    });

    expect(id).toBe("project:given");
    expect(calls).toEqual([[GIVEN_SERVER, CWD, GIVEN_KEY]]);
  });

  test("a given config is used even when no config file exists", async () => {
    const { calls, resolve } = recordingResolver(async () => "project:given");

    const id = await activeProjectId(CWD, { config: GIVEN_CONFIG, resolve });

    expect(id).toBe("project:given");
    expect(calls).toEqual([[GIVEN_SERVER, CWD, undefined]]);
  });

  test("a rejecting resolver resolves null and logs exactly one warning with the error message", async () => {
    const { resolve } = rejecting("server unreachable: ECONNREFUSED");
    const { warnings, log } = recordingLogger();

    const id = await activeProjectId(CWD, {
      config: GIVEN_CONFIG,
      resolve,
      log,
    });

    expect(id).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain(
      "server unreachable: ECONNREFUSED",
    );
  });

  test("a rejecting resolver with no logger resolves null and does not throw", async () => {
    const { resolve } = rejecting("server unreachable");

    const id = await activeProjectId(CWD, { config: GIVEN_CONFIG, resolve });

    expect(id).toBeNull();
  });
});
