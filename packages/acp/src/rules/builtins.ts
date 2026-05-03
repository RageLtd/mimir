/**
 * Built-in rule detectors.
 *
 * Some rules can't be expressed as pure regex over tool inputs — the
 * file-length cap, for instance, has to read the target file from disk,
 * simulate the post-edit content, and count lines. Rather than re-add
 * the executable-sidecar attack surface, mimir ships a small set of
 * trusted builtin detectors with typed args and the loader dispatches
 * to them via `detector = "builtin:<name>"` in `.enforce.toml`.
 *
 * Adding a builtin: implement a function that takes `DetectorContext`
 * + the rule's `detectorArgs`, returns a `Violation[]`. Register it in
 * `BUILTINS` below. Document its argument shape in the JSDoc — that's
 * the schema users will write against.
 */
import * as path from "node:path";
import type { DetectorContext, Violation } from "./types";

/**
 * Signature for a builtin detector. Async to allow disk reads (the
 * file-length detector needs to read the on-disk file to simulate
 * Edit/MultiEdit post-state).
 */
export type BuiltinDetector = (
  ctx: DetectorContext,
  args: Readonly<Record<string, unknown>>,
) => Promise<readonly Violation[]>;

// ── builtin:file-length ──

/**
 * Args:
 *   limit: number  — maximum line count after the edit completes
 *
 * Reads the target file from disk (when present), simulates the edit
 * (Edit / Write / MultiEdit), and emits a single violation when the
 * post-edit line count exceeds `limit`.
 */
const fileLengthDetector: BuiltinDetector = async (ctx, args) => {
  const limit = typeof args.limit === "number" ? args.limit : 500;
  const filePath = pickFilePath(ctx);
  if (!filePath) return [];

  const projected = await projectedLineCount(ctx, filePath);
  if (projected === null || projected <= limit) return [];

  return [
    {
      message: `File would be ${projected} lines after this edit (limit: ${limit}). See the paired rule.`,
    },
  ];
};

/** Resolve the target file path for a file-edit tool call. */
const pickFilePath = (ctx: DetectorContext) => {
  const v = ctx.toolInput.file_path ?? ctx.toolInput.path;
  if (typeof v !== "string" || v.length === 0) return null;
  return path.isAbsolute(v) ? v : path.join(ctx.projectPath, v);
};

/**
 * Count the lines the file would have AFTER the pending tool call
 * applies. Returns null when we can't determine — caller treats null
 * as "no violation" rather than emitting a misleading number.
 */
const projectedLineCount = async (ctx: DetectorContext, filePath: string) => {
  const tool = ctx.toolName;
  const input = ctx.toolInput;

  if (
    tool === "Write" ||
    tool === "fs_write_text_file" ||
    tool === "write_text_file"
  ) {
    const content = input.content;
    return typeof content === "string" ? countLines(content) : null;
  }

  if (tool === "Edit") {
    const oldString = input.old_string;
    const newString = input.new_string;
    if (typeof oldString !== "string" || typeof newString !== "string") {
      return null;
    }
    const current = await readFileOrNull(filePath);
    if (current === null || !current.includes(oldString)) return null;
    return countLines(current.replace(oldString, newString));
  }

  if (tool === "MultiEdit") {
    if (!Array.isArray(input.edits)) return null;
    let buf = await readFileOrNull(filePath);
    if (buf === null) return null;
    for (const e of input.edits) {
      if (!e || typeof e !== "object") return null;
      const oldString = (e as { old_string?: unknown }).old_string;
      const newString = (e as { new_string?: unknown }).new_string;
      if (typeof oldString !== "string" || typeof newString !== "string") {
        return null;
      }
      if (!buf.includes(oldString)) return null;
      buf = buf.replace(oldString, newString);
    }
    return countLines(buf);
  }

  return null;
};

/** Read a file's text without throwing — returns null on any read failure. */
const readFileOrNull = (filePath: string) =>
  Bun.file(filePath)
    .text()
    .then((s) => s as string | null)
    .catch(() => null);

const countLines = (s: string) => s.split("\n").length;

// ── Registry ──

/**
 * Built-in detectors registered by `builtin:<name>` identifier. Loader
 * uses `BUILTINS.has(name)` to validate the `detector` field; runner
 * uses `BUILTINS.get(name)` to dispatch.
 */
export const BUILTINS: ReadonlyMap<string, BuiltinDetector> = new Map([
  ["file-length", fileLengthDetector],
]);

/**
 * Resolve a `detector` field to its implementation. Returns null when
 * the identifier doesn't match a registered builtin. Caller (loader)
 * treats null as a `LoadError`.
 */
export const resolveBuiltin = (detectorId: string) => {
  const prefix = "builtin:";
  if (!detectorId.startsWith(prefix)) return null;
  return BUILTINS.get(detectorId.slice(prefix.length)) ?? null;
};
