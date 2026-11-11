/**
 * File context on Read — the `tool.call` hook on the built-in Read tool.
 *
 * Runs `mimir-cc file-context` (cartographer symbols, imports and
 * dependents from the local index, related memories from the replica)
 * alongside the read itself, and attaches its block to the result as
 * `context`: what the model reads after the file, which the developer
 * never sees. The binary dedupes per session by content hash, so a file
 * read twice unchanged is framed once.
 *
 * Overlapping reads of one file collapse: the read that claims the file
 * (`reading` in `$.state`, `{ at }` compare-and-set on its path, whatever
 * the offset or limit) runs the binary; a read of the same file while that
 * run is in flight runs nothing and returns its own result at once,
 * without a block — the owner's block frames the file for both. The
 * claim is given back when the read settles, failed or not, so the
 * file's next read runs again and the binary's hash dedupe decides. A
 * claim older than READING_STALE_MS is dead (a release that failed, a
 * read cut off mid-run) and blocks nothing.
 *
 * The two run at once — the read never waits on the index, its own or
 * another read's. Fails open with a status line.
 */

import type {
  EngineInterface,
  ProcessRunResult,
  Register,
  ToolCallInput,
} from "claude-code";
import type { MimirReading } from "../types";
import { mimirCcArgv, mimirCcInit } from "./binary";
import { parsePreToolUseOutput, toolInputOf, toolPayload } from "./payload";

const FILE_CONTEXT_TIMEOUT_MS = 15_000;
/** Twice the run's own timeout: a claim this old outlived its read. */
export const READING_STALE_MS = 2 * FILE_CONTEXT_TIMEOUT_MS;

const isLive = (claim: MimirReading | null | undefined, now: number) =>
  claim != null && now - claim.at < READING_STALE_MS;

/** Claims `path` for this read: false while another read's claim is live. */
const claimRead = async ($: EngineInterface, path: string) => {
  const [held, now] = await Promise.all([
    $.state.get({ plugin: "mimir-cc", key: "reading", id: path }),
    $.clock.now(),
  ]);
  if (isLive(held.value, now)) return false;
  const claimed = await $.state.set(
    { plugin: "mimir-cc", key: "reading", id: path },
    { at: now },
    { ifVersion: held.version },
  );
  return claimed.isSet;
};

/**
 * Gives the claim back. A release that fails must not fail the read — that
 * would run it again — so it is reported and the claim left to go stale.
 */
const releaseRead = ($: EngineInterface, path: string) =>
  $.state.set({ plugin: "mimir-cc", key: "reading", id: path }, null).then(
    () => undefined,
    () => $.ui.status("mimir: file context claim not released"),
  );

/** The leg's outcome: context and status to show, from the run or its failure. */
export const fileContextOutcome = (
  settled: PromiseSettledResult<ProcessRunResult>,
) => {
  if (settled.status === "rejected")
    return { status: "mimir: file context failed" };
  const ran = settled.value;
  if (ran.exitCode !== 0)
    return { status: `mimir: file context failed (exit ${ran.exitCode})` };
  const out = parsePreToolUseOutput(ran.stdout);
  return {
    status: out.systemMessage,
    context: out.hookSpecificOutput?.additionalContext,
  };
};

/** The file a Read names — its `reading` id — if it names one. */
export const readPathOf = (e: ToolCallInput) => {
  const input = toolInputOf(e);
  const path = "file_path" in input ? input.file_path : undefined;
  return typeof path === "string" && path.length > 0 ? path : undefined;
};

/** The read beside its file-context run, both settled. */
const readWithContext = async <R>(
  $: EngineInterface,
  e: ToolCallInput,
  read: () => Promise<R>,
) => {
  const [home, sessionId, cwd] = await Promise.all([
    $.env.get("HOME"),
    $.session.id(),
    $.session.cwd(),
  ]);
  const payload = toolPayload(e, { sessionId, cwd, agentId: e.agentId });
  return Promise.all([
    read(),
    Promise.allSettled([
      $.process.run(
        mimirCcArgv(home ?? "", "file-context"),
        mimirCcInit(payload, FILE_CONTEXT_TIMEOUT_MS),
      ),
    ]),
  ]);
};

export const registerFileContext: Register = (on) => {
  on("tool.call", { tool: "Read" }, async ($, e, next) => {
    const path = readPathOf(e);
    if (path !== undefined && !(await claimRead($, path))) return next(e);
    const [ran, [leg]] = await readWithContext($, e, () => next(e)).finally(
      () => (path === undefined ? undefined : releaseRead($, path)),
    );
    const outcome = fileContextOutcome(leg);
    if (outcome.status !== undefined) $.ui.status(outcome.status);
    return outcome.context === undefined || ran.deny !== undefined
      ? ran
      : { ...ran, context: [...(ran.context ?? []), outcome.context] };
  }).catch(($, e, next) => {
    $.ui.status("mimir: file context failed");
    return next(e);
  });
};
