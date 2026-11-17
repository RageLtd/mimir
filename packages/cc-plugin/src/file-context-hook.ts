/**
 * File-context injection on Read — `mimir-cc file-context`, run by the
 * hooks module's `tool.call` hook on the built-in Read tool with the
 * PreToolUse payload.
 *
 * Builds cartographer info (symbols, imports, dependents) from the LOCAL
 * cart index and semantically-related memories from the local replica
 * (MIM-91 — no server round-trip), and emits them as `additionalContext`,
 * which the module attaches to the read's result so the model frames the
 * file with that knowledge.
 *
 * Dedup is hash-keyed, not path-keyed: the session's state records, per
 * file, the content hash last injected (`claimInjection`), and
 * re-injection happens only when the index's content_hash differs from
 * the recorded one. The claim is atomic across processes, so two reads
 * racing on one file inject it once. Because a record is keyed by hash,
 * an Edit → reindex cycle frames the file again on its own (the reindex
 * worker updates the local index's content_hash, the next Read claims a
 * hash with no record yet, and re-injection fires).
 *
 * Never blocks the read. Empty index result (file not indexed) ⇒
 * skip injection without an error.
 */

import { link, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  fileContextSummary,
  lookupFileInfo,
  renderFileContext,
} from "@mimir/plugin-core/cartographer/file-context-render";
import {
  resolveProjectRoot,
  toProjectRelative,
} from "@mimir/plugin-core/project";
import { activeProjectId } from "@mimir/plugin-core/project/active";
import { attempt } from "@mimir/plugin-core/result";
import { mimirHome } from "@mimir/plugin-core/util";
import { readConfig } from "./config";
import { readPayload } from "./hook-payload";
import { createLogger } from "./logger";

const log = createLogger("file-context-hook");

type HookInput = {
  readonly session_id?: string;
  readonly hook_event_name?: string;
  readonly tool_name?: string;
  readonly tool_input?: unknown;
  readonly cwd?: string;
};

export { countMemories } from "@mimir/plugin-core/cartographer/file-context-render";

const STATE_DIR = "file-context-state";
const RECORD_SUFFIX = ".json";

/** Where every session's file-context state lives; file-context-sweep.ts prunes it. */
export const fileContextStateDir = () => join(mimirHome(), STATE_DIR);
const DRAFT_SUFFIX = ".draft";

const digest = (text: string) =>
  new Bun.CryptoHasher("sha256").update(text).digest("hex");

/**
 * One directory per file this session has framed, holding one record per
 * content hash claimed for it. A directory of its own per file is what keeps
 * concurrent claims for different files from overwriting each other's
 * record. The previous layout's `<sessionId>.json` sits beside the session
 * directory and is never read: under it, nothing is recorded.
 */
const recordDir = (sessionId: string, filePath: string) =>
  join(fileContextStateDir(), sessionId, digest(filePath));

const recordName = (contentHash: string) =>
  `${digest(contentHash)}${RECORD_SUFFIX}`;

const discard = (path: string) => rm(path, { force: true });

const holdsHash = async (record: string, contentHash: string) => {
  const [err, held] = await attempt(async () =>
    JSON.parse(await Bun.file(record).text()),
  );
  return err === null && held === contentHash;
};

/** A claimed hash supersedes the file's earlier ones, so going back to one injects again. */
const dropOtherHashes = async (dir: string, keep: string) => {
  const entries = await readdir(dir);
  await Promise.all(
    entries
      .filter((name) => name.endsWith(RECORD_SUFFIX) && name !== keep)
      .map((name) => discard(join(dir, name))),
  );
};

/**
 * Claims the injection of `filePath` at `contentHash` for this session:
 * true when this caller is to inject, false when the file was already
 * framed at that hash. The record is linked into place from a fully written
 * draft, and a link fails when the name exists — so of the processes
 * racing on one file and hash over a healthy record, one claims it. A
 * record that does not hold its hash (corrupt) counts as not recorded and
 * is repaired by rename; claimers racing on that repair may each win,
 * which costs an extra injection, never a missing one.
 */
export const claimInjection = async (
  sessionId: string,
  filePath: string,
  contentHash: string,
) => {
  const dir = recordDir(sessionId, filePath);
  const name = recordName(contentHash);
  const record = join(dir, name);
  const draft = join(dir, `${name}.${crypto.randomUUID()}${DRAFT_SUFFIX}`);
  await mkdir(dir, { recursive: true });
  await Bun.write(draft, JSON.stringify(contentHash));
  const [linkErr] = await attempt(() => link(draft, record));
  if (linkErr === null) {
    await discard(draft);
    await dropOtherHashes(dir, name);
    return true;
  }
  if (!("code" in linkErr) || linkErr.code !== "EEXIST") {
    await discard(draft);
    throw linkErr;
  }
  if (await holdsHash(record, contentHash)) {
    await discard(draft);
    return false;
  }
  await rename(draft, record);
  await dropOtherHashes(dir, name);
  return true;
};

/** Gives a claim back, so the file's next read can inject at that hash. */
const releaseInjection = (
  sessionId: string,
  filePath: string,
  contentHash: string,
) => discard(join(recordDir(sessionId, filePath), recordName(contentHash)));

const safeParseHookInput = async (raw: string) => {
  if (raw.trim().length === 0) return {} as HookInput;
  const [err, parsed] = await attempt(async () => JSON.parse(raw) as HookInput);
  return err ? ({} as HookInput) : parsed;
};

const extractFilePath = (input: HookInput) => {
  const ti = input.tool_input;
  if (!ti || typeof ti !== "object") return null;
  const fp = (ti as Record<string, unknown>).file_path;
  return typeof fp === "string" && fp.length > 0 ? fp : null;
};

const emitInjection = (block: string, summary: string) => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: block,
      },
      // The "↻ File context" line; the hooks module puts it on the status bar.
      systemMessage: summary,
    }),
  );
};

/**
 * Entry point invoked from cli.ts when argv[2] === "file-context".
 *
 * Exit 0 unconditionally. PreToolUse non-zero exits would surface as a
 * tool error — losing context augmentation is much better than that.
 */
export const runFileContextHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;

  const raw = await readPayload();
  const input = await safeParseHookInput(raw);

  if (input.tool_name !== "Read") return 0;

  const sessionId = input.session_id ?? "default";
  const cwd = input.cwd ?? process.cwd();
  // The session cwd follows Bash `cd`; cart rows key on the repository root.
  const projectRoot = await resolveProjectRoot(cwd);
  const filePath = extractFilePath(input);

  if (!filePath) {
    log.debug("no file_path in tool_input — skipping");
    return 0;
  }

  const config = await readConfig();
  if (!config) {
    log.debug("no config — skipping file-context");
    return 0;
  }

  // Project id (disk-cached after the first hook of a session; keys on the
  // repository root internally). Used only as the memory-scoring
  // tiebreaker — the cart lookup itself is keyed by rootPath and needs no
  // server at all.
  const projectId = await activeProjectId(cwd, { config });

  // Cart rows store project-relative paths. Query by the same
  // representation or every lookup misses. The dedup cache key uses the
  // relative form too — anything else would silently re-inject when CC
  // hands us the same file via a path that round-trips differently.
  const relativeFilePath = toProjectRelative(projectRoot, filePath);

  const info = await lookupFileInfo({
    rootPath: projectRoot,
    filePath: relativeFilePath,
    projectId,
    log,
  });
  if (!info) return 0;

  // File not in cartographer index — no contentHash, no content to inject.
  // Logged at INFO (not DEBUG) so missed-index reads are visible by
  // default; otherwise debugging "why isn't the hook firing on file X"
  // requires turning on MIMIR_DEBUG and replaying.
  if (!info.contentHash || info.contentHash.length === 0) {
    log.info("file not indexed by cartographer — skipping injection", {
      filePath,
      relativeFilePath,
    });
    return 0;
  }

  const block = renderFileContext(filePath, info);
  if (block.length === 0) {
    log.debug("file-info returned empty context — skipping injection", {
      filePath,
    });
    return 0;
  }

  const summary = fileContextSummary(info);

  // Claimed only once there is a block to emit, and given back if emitting
  // fails — a file is recorded as framed only when its block went out.
  const contentHash = info.contentHash;
  const [claimErr, claimed] = await attempt(() =>
    claimInjection(sessionId, relativeFilePath, contentHash),
  );
  if (claimErr) {
    log.warn("file-context claim failed — injecting unrecorded", {
      filePath,
      error: claimErr.message,
    });
  } else if (!claimed) {
    log.debug("file-context already injected for this hash", {
      filePath,
      relativeFilePath,
      hash: contentHash,
    });
    return 0;
  }

  const [emitErr] = await attempt(async () => emitInjection(block, summary));
  if (emitErr) {
    log.warn("file-context emit failed — releasing the claim", {
      filePath,
      error: emitErr.message,
    });
    if (!claimErr)
      await releaseInjection(sessionId, relativeFilePath, contentHash);
    return 0;
  }

  log.info("file-context injected", {
    sessionId,
    filePath,
    relativeFilePath,
    projectId,
    contentHash: info.contentHash,
    symbols: info.symbols?.length ?? 0,
    imports: info.imports?.length ?? 0,
    dependents: info.dependents?.length ?? 0,
    hasMemories: !!info.memories,
    blockChars: block.length,
  });

  return 0;
};
