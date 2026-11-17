/**
 * A hook subcommand takes its payload from the file the hooks module named
 * in argv, and that file is gone once read. Only a file in the payload
 * directory is the binary's to delete.
 */

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PAYLOAD_MAX_AGE_MS,
  payloadPathOf,
  readPayload,
  sweepPayloads,
  withoutPayloadFlag,
} from "./hook-payload";

const scratch = () => mkdtemp(join(tmpdir(), "mimir-payload-"));

describe("the payload flag", () => {
  test("names the payload's file", () => {
    expect(payloadPathOf(["rules", "--payload", "/run/a.json"])).toBe(
      "/run/a.json",
    );
    expect(payloadPathOf(["rules"])).toBeUndefined();
  });

  test("comes off argv with its value, wherever it sits, so a subcommand's own arguments parse as before", () => {
    expect(withoutPayloadFlag(["verify", "--payload", "/run/a.json"])).toEqual([
      "verify",
    ]);
    expect(
      withoutPayloadFlag(["guard", "--payload", "/run/a.json", "--role", "x"]),
    ).toEqual(["guard", "--role", "x"]);
    expect(withoutPayloadFlag(["reindex", "--worker", "/p", "/f"])).toEqual([
      "reindex",
      "--worker",
      "/p",
      "/f",
    ]);
  });
});

describe("readPayload", () => {
  test("a payload file in the payload directory is read, then deleted", async () => {
    const dir = await scratch();
    const path = join(dir, "persist-1.json");
    await writeFile(path, '{"session_id":"s"}');

    const text = await readPayload(["persist", "--payload", path], dir);

    expect(text).toBe('{"session_id":"s"}');
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test("a file outside the payload directory is read and left where it is", async () => {
    const dir = await scratch();
    const elsewhere = join(await scratch(), "notes.json");
    await writeFile(elsewhere, '{"a":1}');

    const text = await readPayload(["persist", "--payload", elsewhere], dir);

    expect(text).toBe('{"a":1}');
    expect(await Bun.file(elsewhere).exists()).toBe(true);
  });

  test("a payload file that is not there reads as no payload", async () => {
    const dir = await scratch();

    const text = await readPayload(
      ["persist", "--payload", join(dir, "gone.json")],
      dir,
    );

    expect(text).toBe("");
  });
});

describe("sweepPayloads", () => {
  test("a payload file no run can still be reading goes; a fresh one stays", async () => {
    const dir = await scratch();
    const now = Date.now();
    const stale = join(dir, "persist-old.json");
    const fresh = join(dir, "persist-new.json");
    await writeFile(stale, "{}");
    await writeFile(fresh, "{}");
    const old = new Date(now - PAYLOAD_MAX_AGE_MS - 1_000);
    await utimes(stale, old, old);

    const outcome = await sweepPayloads(now, dir);

    expect(outcome).toEqual({ removed: 1, failures: [] });
    expect(await Bun.file(stale).exists()).toBe(false);
    expect(await Bun.file(fresh).exists()).toBe(true);
  });

  test("no payload directory yet is nothing to sweep", async () => {
    const outcome = await sweepPayloads(
      Date.now(),
      join(await scratch(), "run"),
    );

    expect(outcome).toEqual({ removed: 0, failures: [] });
  });
});

describe("mimir-cc run with a payload file", () => {
  test("verify takes the flag as its payload, not as its own arguments, and the file is gone after", async () => {
    const home = await scratch();
    const dir = join(home, ".mimir", "run");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "verify-1.json");
    await writeFile(path, "{}");

    const proc = Bun.spawn(
      ["bun", join(import.meta.dir, "cli.ts"), "verify", "--payload", path],
      {
        env: {
          ...process.env,
          MIMIR_ACTIVE: "1",
          HOME: home,
          MIMIR_HOME: join(home, ".mimir"),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ]);

    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    expect(await Bun.file(path).exists()).toBe(false);
  });
});
