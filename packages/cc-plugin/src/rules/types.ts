/**
 * Rule-engine schema types. Ported verbatim from
 * packages/acp/src/rules/types.ts.
 *
 * Each rule lives in a `.enforce.toml` file under `.claude/`. The file
 * shape mirrors hookify's rule vocabulary (`event`, `conditions`,
 * `field`/`operator`/`pattern`) so syntax stays familiar, with mimir
 * extensions (`exclude_globs`, `negative_conditions`, `detector`,
 * `body`, `id`, `message`) co-existing on the same surface.
 *
 * Engine flow:
 *   loader → array of `RuleEntry` (validated)
 *   runner.runRules(entries, ctx) → array of `Finding`
 *   format.formatFindings(findings) → string for the model
 */

/**
 * Hookify event vocabulary. The runner maps each event to a backend-
 * specific set of tool names so rules can be authored once and apply
 * across CC and server backends.
 *   bash    → terminal commands (CC: Bash; server: create_terminal/terminal)
 *   file    → file edits (CC: Edit/Write/MultiEdit; server: fs_write_text_file/write_text_file)
 *   stop    → agent wants to stop the turn
 *   prompt  → user submitted a prompt
 *   all     → every event type
 */
export type RuleEvent = "bash" | "file" | "stop" | "prompt" | "all";

/**
 * Condition operator vocabulary. Subset of hookify's operators —
 * extend as new rule patterns demand it. `regex_match` is the workhorse;
 * the others are sugar for cheaper exact matches.
 */
export type Operator = "regex_match" | "contains" | "equals";

/** A single condition as authored in TOML. */
export interface Condition {
  readonly field: string;
  readonly operator: Operator;
  readonly pattern: string;
}

/**
 * Loader-compiled form of `Condition`. Regex patterns get pre-validated
 * and compiled at session start so the matcher stays synchronous and
 * never throws — and so a malformed regex surfaces as a `LoadError`
 * rather than as a per-tool-call runtime crash.
 */
export interface CompiledCondition extends Condition {
  /** Compiled regex, populated when `operator === "regex_match"`. */
  readonly regex?: RegExp;
}

/**
 * One enforcement rule, materialised from a single `.enforce.toml` file.
 * The loader resolves `body` to an absolute path and pre-loads
 * `bodyContent`; the matcher and formatter consume the resolved fields.
 */
export interface RuleEntry {
  /** Unique rule identifier across all loaded files. */
  readonly id: string;
  /**
   * Absolute path to the rule body markdown. Resolved by the loader
   * from the relative path in TOML (relative to the .toml's directory).
   * Undefined when the rule is enforcement-only (message field is the
   * entire user-facing surface).
   */
  readonly body?: string;
  /** Pre-loaded body file content. Loader populates; runner doesn't re-read. */
  readonly bodyContent?: string;
  readonly enabled: boolean;
  readonly event: RuleEvent;
  /**
   * Mimir extension. Glob patterns matched against `file_path` — if any
   * match, the rule does not fire. Negation primitive that hookify's
   * AND-only conditions can't express directly.
   */
  readonly excludeGlobs?: readonly string[];
  /**
   * Optional template for the model-facing violation message. Supports
   * `${1}..${9}` capture-group interpolation, `${match}` for the entire
   * matched substring, and `${line}` for the 1-indexed line number when
   * available. When unset, the rule body content is used verbatim with a
   * generic violation header prepended.
   */
  readonly message?: string;
  /**
   * Built-in detector identifier. When set, bypasses the regex engine
   * entirely and dispatches to a typed implementation in `builtins.ts`.
   * Format: `builtin:<name>` (e.g. `builtin:file-length`).
   */
  readonly detector?: string;
  /** Arguments passed to the builtin detector. Shape is detector-specific. */
  readonly detectorArgs?: Readonly<Record<string, unknown>>;
  /** AND-joined condition list. Required when `detector` is unset. */
  readonly conditions?: readonly CompiledCondition[];
  /**
   * AND-NOT-joined condition list. Mimir extension. If any of these
   * match, the rule is suppressed for this event — the cheap way to
   * express "this is a violation UNLESS [...]" without losing
   * regex-language compatibility.
   */
  readonly negativeConditions?: readonly CompiledCondition[];
  /** Source path of the .enforce.toml file (for diagnostics). */
  readonly sourcePath: string;
}

/**
 * Per-tool-call context passed to the matcher/runner. Built by each
 * backend's adapter from its native tool-call event shape.
 */
export interface DetectorContext {
  /**
   * Backend-native tool name as observed in the tool call. Used for
   * event-to-tool mapping in `runner.eventMatchesTool`.
   */
  readonly toolName: string;
  readonly toolInput: Readonly<Record<string, unknown>>;
  /** Project root, used for resolving relative paths in builtins. */
  readonly projectPath: string;
}

/** A single rule violation surfaced by a matcher or builtin. */
export interface Violation {
  readonly message: string;
  readonly line?: number;
  readonly snippet?: string;
}

/** Rule + the violations it surfaced for the current tool call. */
export interface Finding {
  readonly rule: RuleEntry;
  readonly violations: readonly Violation[];
}

/**
 * Loader diagnostic. Eager validation surfaces every problem so the
 * agent can emit one consolidated session-start error rather than
 * discovering broken rules ad-hoc when they would have fired.
 */
export interface LoadError {
  /** Path to the .enforce.toml that failed to load. */
  readonly path: string;
  /** Rule id, when the loader got far enough to extract it. */
  readonly id?: string;
  /** Human-readable explanation of the failure. */
  readonly message: string;
}

/** Loader return shape — successful entries plus all surfaced errors. */
export interface LoadResult {
  readonly rules: readonly RuleEntry[];
  readonly errors: readonly LoadError[];
}
