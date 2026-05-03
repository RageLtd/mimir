/**
 * Rule loader — glob, parse, and validate `.enforce.toml` files.
 *
 * Discovery: every file matching `.claude/**\/*.enforce.toml` under the
 * project root. Per-file shape: one rule per file (no top-level
 * `[[rule]]` table needed). Body files referenced via `body = "..."`
 * are pre-loaded so the runner never touches the disk during
 * evaluation.
 *
 * Validation is eager — any file with a malformed schema, broken regex
 * pattern, missing body file, or unknown builtin produces a
 * `LoadError`. Results come back as `{ rules, errors }` so the agent
 * layer can surface a consolidated session-start error to the editor
 * rather than having broken rules silently disappear.
 *
 * Bun's built-in TOML parser handles parsing — no extra dependency.
 */
import { Glob } from "bun";
import * as path from "node:path";
import { errMessage } from "../util";
import { resolveBuiltin } from "./builtins";
import { compileCondition } from "./runner";
import type {
  CompiledCondition,
  Condition,
  LoadError,
  Operator,
  RuleEntry,
  RuleEvent,
} from "./types";

/** Glob pattern for rule discovery, relative to project root. */
const ENFORCE_GLOB = ".claude/**/*.enforce.toml";

/** Hookify event vocabulary — anything else is a `LoadError`. */
const VALID_EVENTS: ReadonlySet<RuleEvent> = new Set([
  "bash",
  "file",
  "stop",
  "prompt",
  "all",
]);

/** Operator vocabulary the matcher knows how to evaluate. */
const VALID_OPERATORS: ReadonlySet<Operator> = new Set([
  "regex_match",
  "contains",
  "equals",
]);

const bunTOML = (Bun as unknown as {
  TOML: { parse(s: string): Record<string, unknown> };
}).TOML;

/**
 * Load and validate every `.enforce.toml` under `projectPath`.
 *
 * Returns `{ rules, errors }` — both arrays may be non-empty
 * simultaneously. The agent emits one error notification listing every
 * `LoadError`; the runner uses `rules` regardless. Duplicate `id`
 * values across files surface as a `LoadError` for the second-loaded
 * file (first wins, the duplicate is dropped).
 */
export const loadRules = async (projectPath: string) => {
  const glob = new Glob(ENFORCE_GLOB);
  const rules: RuleEntry[] = [];
  const errors: LoadError[] = [];
  const seenIds = new Set<string>();

  // `dot: true` is required because the discovery root lives under
  // `.claude/`. Bun's Glob (like most modern globs) skips dot-prefixed
  // path components by default; without this, the loader silently finds
  // zero rules.
  for await (const relativePath of glob.scan({ cwd: projectPath, dot: true })) {
    const absPath = path.join(projectPath, relativePath);
    const result = await loadOne(absPath, projectPath);
    if (!result.ok) {
      errors.push(result.error);
      continue;
    }
    if (seenIds.has(result.rule.id)) {
      errors.push({
        path: absPath,
        id: result.rule.id,
        message: `duplicate rule id "${result.rule.id}" — first definition wins, this file is ignored`,
      });
      continue;
    }
    seenIds.add(result.rule.id);
    rules.push(result.rule);
  }

  return { rules, errors } as const;
};

/**
 * Load and validate one `.enforce.toml`. Returns either the rule or a
 * `LoadError`. All TOML / file-reading errors are converted to
 * `LoadError` rather than thrown so the caller's `for await` loop
 * stays linear.
 */
const loadOne = async (absPath: string, projectPath: string) => {
  const text = await Bun.file(absPath)
    .text()
    .then((s) => ({ ok: true as const, text: s }))
    .catch((err) => ({
      ok: false as const,
      error: errMessage(err),
    }));
  if (!text.ok) {
    return failure(absPath, undefined, `read failed: ${text.error}`);
  }

  const parsed = await Promise.resolve()
    .then(() => ({ ok: true as const, value: bunTOML.parse(text.text) }))
    .catch((err) => ({ ok: false as const, error: errMessage(err) }));
  if (!parsed.ok) {
    return failure(absPath, undefined, `TOML parse failed: ${parsed.error}`);
  }

  const raw = parsed.value;
  const id = typeof raw.id === "string" ? raw.id : undefined;
  if (!id) {
    return failure(absPath, undefined, "missing required `id` field");
  }

  const event = raw.event;
  if (typeof event !== "string" || !VALID_EVENTS.has(event as RuleEvent)) {
    return failure(
      absPath,
      id,
      `invalid \`event\` value "${String(event)}" — must be one of: ${[...VALID_EVENTS].join(", ")}`,
    );
  }

  // Body resolution: relative to the .toml's directory; absent is fine.
  const bodyResult = await resolveBody(raw.body, absPath);
  if (!bodyResult.ok) {
    return failure(absPath, id, bodyResult.error);
  }

  // Detector vs conditions — the schema requires exactly one of these
  // sources. A rule with neither has no way to fire; with both, the
  // runner only consults `detector` and the conditions silently
  // dangle. Surface that as a load error so the author fixes it now.
  const hasDetector = typeof raw.detector === "string";
  const hasConditions =
    Array.isArray(raw.conditions) && raw.conditions.length > 0;
  if (!hasDetector && !hasConditions) {
    return failure(
      absPath,
      id,
      "must declare either `detector = \"builtin:...\"` or at least one `[[conditions]]` block",
    );
  }
  if (hasDetector && hasConditions) {
    return failure(
      absPath,
      id,
      "cannot declare both `detector` and `[[conditions]]` — pick one",
    );
  }

  let detector: string | undefined;
  let detectorArgs: Record<string, unknown> | undefined;
  if (hasDetector) {
    detector = raw.detector as string;
    if (!resolveBuiltin(detector)) {
      return failure(
        absPath,
        id,
        `unknown detector "${detector}" — see builtins.ts for registered identifiers`,
      );
    }
    if (raw.detector_args && typeof raw.detector_args === "object") {
      detectorArgs = raw.detector_args as Record<string, unknown>;
    }
  }

  // Compile every condition's regex eagerly so the matcher can stay
  // synchronous + crash-free at evaluation time.
  const compiled = await compileConditionList(raw.conditions, "conditions");
  if (!compiled.ok) {
    return failure(absPath, id, compiled.error);
  }
  const compiledNeg = await compileConditionList(
    raw.negative_conditions,
    "negative_conditions",
  );
  if (!compiledNeg.ok) {
    return failure(absPath, id, compiledNeg.error);
  }

  // exclude_globs: array of strings.
  let excludeGlobs: string[] | undefined;
  if (raw.exclude_globs !== undefined) {
    if (!Array.isArray(raw.exclude_globs)) {
      return failure(absPath, id, "`exclude_globs` must be an array of strings");
    }
    excludeGlobs = [];
    for (const g of raw.exclude_globs) {
      if (typeof g !== "string") {
        return failure(
          absPath,
          id,
          "`exclude_globs` entries must be strings",
        );
      }
      excludeGlobs.push(g);
    }
  }

  const rule: RuleEntry = {
    id,
    body: bodyResult.body,
    bodyContent: bodyResult.content,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
    event: event as RuleEvent,
    excludeGlobs,
    message: typeof raw.message === "string" ? raw.message : undefined,
    detector,
    detectorArgs,
    conditions: compiled.conditions,
    negativeConditions: compiledNeg.conditions,
    sourcePath: absPath,
  };

  return { ok: true as const, rule };
};

/**
 * Resolve and pre-load the `body` field. Returns the absolute body
 * path + content on success. A declared-but-missing body is a load
 * error (per the "fail loudly" decision); an absent body is fine —
 * the rule's `message` field is the entire user-facing surface.
 */
const resolveBody = async (rawBody: unknown, tomlPath: string) => {
  if (rawBody === undefined) {
    return { ok: true as const, body: undefined, content: undefined };
  }
  if (typeof rawBody !== "string") {
    return {
      ok: false as const,
      error: "`body` must be a string path or omitted",
    };
  }
  const tomlDir = path.dirname(tomlPath);
  const expanded = rawBody.startsWith("~/")
    ? path.join(process.env.HOME ?? "", rawBody.slice(2))
    : rawBody;
  const absBody = path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.normalize(path.join(tomlDir, expanded));

  const read = await Bun.file(absBody)
    .text()
    .then((s) => ({ ok: true as const, content: s }))
    .catch((err) => ({ ok: false as const, error: errMessage(err) }));
  if (!read.ok) {
    return {
      ok: false as const,
      error: `body file unreadable at ${absBody}: ${read.error}`,
    };
  }
  return { ok: true as const, body: absBody, content: read.content };
};

/**
 * Validate a TOML-loaded conditions array, compile each regex
 * pattern, and return the compiled list. Errors short-circuit the
 * whole list (the rule is broken either way).
 */
const compileConditionList = async (raw: unknown, fieldName: string) => {
  if (raw === undefined) {
    return { ok: true as const, conditions: undefined };
  }
  if (!Array.isArray(raw)) {
    return {
      ok: false as const,
      error: `\`${fieldName}\` must be an array of tables`,
    };
  }

  const out: CompiledCondition[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const validated = validateCondition(entry, fieldName, i);
    if (!validated.ok) return validated;
    const compiled = await compileCondition(validated.condition);
    if (!compiled.ok) {
      return {
        ok: false as const,
        error: `${fieldName}[${i}] regex invalid: ${compiled.error}`,
      };
    }
    out.push(compiled.condition);
  }
  return { ok: true as const, conditions: out };
};

/** Validate one TOML-loaded condition table. */
const validateCondition = (entry: unknown, fieldName: string, index: number) => {
  if (!entry || typeof entry !== "object") {
    return {
      ok: false as const,
      error: `${fieldName}[${index}] must be a table`,
    };
  }
  const obj = entry as Record<string, unknown>;
  if (typeof obj.field !== "string" || obj.field.length === 0) {
    return {
      ok: false as const,
      error: `${fieldName}[${index}] missing required \`field\``,
    };
  }
  if (
    typeof obj.operator !== "string" ||
    !VALID_OPERATORS.has(obj.operator as Operator)
  ) {
    return {
      ok: false as const,
      error: `${fieldName}[${index}] invalid \`operator\` "${String(obj.operator)}" — must be one of: ${[...VALID_OPERATORS].join(", ")}`,
    };
  }
  if (typeof obj.pattern !== "string") {
    return {
      ok: false as const,
      error: `${fieldName}[${index}] missing required \`pattern\` string`,
    };
  }
  const condition: Condition = {
    field: obj.field,
    operator: obj.operator as Operator,
    pattern: obj.pattern,
  };
  return { ok: true as const, condition };
};

/** Build a single-error failure result. */
const failure = (path: string, id: string | undefined, message: string) => ({
  ok: false as const,
  error: { path, id, message } satisfies LoadError,
});
