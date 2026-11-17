/**
 * A hook subcommand's payload. The hooks module writes it to a file of its
 * own under `~/.mimir/run/` and names the file in argv (`--payload <path>`):
 * where an organization manages Claude Code, a plugin's run is refused when
 * its stdin names a Claude Code settings file, which a conversation, a
 * prompt or a tool's input may (hooks/binary.ts). A run without the flag —
 * a plugin older than this binary, a spec — still reads stdin.
 *
 * The file is deleted once read; one left by a run that never started is
 * swept at the next session's start.
 *
 * The directory hangs off the home directory, not `mimirHome()`: the
 * module's sandbox is given HOME alone, and both sides must name one place.
 */

import { readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { attempt } from "@mimir/plugin-core/result";
import { createLogger } from "./logger";

const log = createLogger("hook-payload");

const PAYLOAD_FLAG = "--payload";
/** Six times the longest run the engine allows (ten minutes). */
export const PAYLOAD_MAX_AGE_MS = 60 * 60_000;

export const payloadDir = () => join(homedir(), ".mimir", "run");

/** The file `--payload` names, or undefined when argv carries no flag. */
export const payloadPathOf = (argv: readonly string[]) => {
  const at = argv.indexOf(PAYLOAD_FLAG);
  return at === -1 ? undefined : argv[at + 1];
};

/** `argv` as a subcommand's own parser expects it: the flag and its value off. */
export const withoutPayloadFlag = (argv: readonly string[]) => {
  const at = argv.indexOf(PAYLOAD_FLAG);
  return at === -1 ? argv : argv.filter((_, i) => i < at || i > at + 1);
};

const readStdin = async () => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

/**
 * The payload's text: the named file's, or stdin's when none is named. A
 * file that cannot be read is no payload (""), as an empty stdin is.
 */
export const readPayload = async (
  argv: readonly string[] = Bun.argv,
  dir = payloadDir(),
) => {
  const path = payloadPathOf(argv);
  if (path === undefined) return readStdin();
  const [readErr, text] = await attempt(() => readFile(path, "utf8"));
  if (readErr)
    log.warn("payload file unreadable — running without a payload", {
      path,
      error: readErr.message,
    });
  // Only what the module wrote is this binary's to delete.
  if (resolve(path).startsWith(`${resolve(dir)}${sep}`)) {
    const [rmErr] = await attempt(() => rm(path, { force: true }));
    if (rmErr)
      log.warn("payload file not removed", { path, error: rmErr.message });
  }
  return readErr ? "" : text;
};

/** True when removed, false when kept; a failure is reported, not thrown. */
const sweepFile = async (path: string, now: number) => {
  const [statErr, info] = await attempt(() => stat(path));
  if (statErr) return { path, error: statErr.message };
  if (now - info.mtimeMs <= PAYLOAD_MAX_AGE_MS) return false;
  const [rmErr] = await attempt(() => rm(path, { force: true }));
  return rmErr ? { path, error: rmErr.message } : true;
};

/**
 * Removes the payload files no run can still be reading: older than
 * PAYLOAD_MAX_AGE_MS. Resolves to `{ removed, failures }`; never throws.
 */
export const sweepPayloads = async (now: number, dir = payloadDir()) => {
  const [listErr, entries] = await attempt(() =>
    readdir(dir, { withFileTypes: true }),
  );
  if (listErr) {
    const absent = "code" in listErr && listErr.code === "ENOENT";
    return {
      removed: 0,
      failures: absent ? [] : [{ path: dir, error: listErr.message }],
    };
  }
  const outcomes = await Promise.all(
    entries
      .filter((entry) => entry.isFile())
      .map((entry) => sweepFile(join(dir, entry.name), now)),
  );
  return {
    removed: outcomes.filter((outcome) => outcome === true).length,
    failures: outcomes.flatMap((outcome) =>
      typeof outcome === "object" ? [outcome] : [],
    ),
  };
};
