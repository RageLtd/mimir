/**
 * Rule-detect hooks — mechanical enforcement of project rules.
 *
 * Contract: any rule at `.claude/rules/<path>/<name>.md` may ship an
 * optional sidecar `.claude/rules/<path>/<name>.detect.ts`. The sidecar
 * default-exports a function that inspects an Edit/Write/MultiEdit tool
 * call and returns an array of violations. Mimir loads the sidecars at
 * session start, runs them inside a PreToolUse hook, and — when any fire —
 * injects a short reminder as `additionalContext` so the model sees the
 * violation before the edit is committed.
 *
 * The sidecar is opt-in and ignored by standard Claude Code, which only
 * reads the markdown. Keeping `.detect.ts` co-located with its rule means
 * the rule itself owns the mechanical check; mimir adds no knowledge of
 * specific rules, just runs what's there.
 *
 * Sidecar shape (no imports required):
 *   export default (input: DetectInput) => Violation[] | null;
 */

import { Glob } from "bun";
import { errMessage } from "../../util";
import { createChildLogger, log } from "../../utils/log";

// Minimal path helpers — avoid the node:path import for four calls.
const pathJoin = (...parts: string[]) =>
  parts
    .filter((p) => p.length > 0)
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, "")))
    .join("/");

const pathDirname = (p: string) => {
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "/" : p.slice(0, idx);
};

const pathBasename = (p: string, ext?: string) => {
  const base = p.slice(p.lastIndexOf("/") + 1);
  return ext && base.endsWith(ext) ? base.slice(0, -ext.length) : base;
};

const pathRelative = (from: string, to: string) => {
  const fromParts = from.split("/").filter(Boolean);
  const toParts = to.split("/").filter(Boolean);
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) {
    i++;
  }
  const up = Array(fromParts.length - i).fill("..");
  return [...up, ...toParts.slice(i)].join("/");
};

const logger = createChildLogger(log, "rule-hooks");

/** Input passed to every detect function on each tool call. */
export interface DetectInput {
  /** Tool name — "Edit", "Write", "MultiEdit", etc. */
  readonly toolName: string;
  /** Raw tool input object — shape depends on the tool. */
  readonly toolInput: Record<string, unknown>;
  /**
   * File being modified, extracted from the tool input when possible.
   * Undefined for tools that don't target a single file.
   */
  readonly filePath?: string;
  /**
   * Content that will land in the file after the edit, extracted when
   * possible. For Edit this is `new_string`; for Write it's `content`.
   * Detectors that need the full file content should read from disk.
   */
  readonly content?: string;
}

/** A single rule violation. Rules own the wording of `message`. */
export interface Violation {
  /** Short human-readable description of what's wrong. */
  readonly message: string;
  /** Optional line number (1-indexed) where the violation occurs. */
  readonly line?: number;
  /** Optional code snippet highlighting the offending text. */
  readonly snippet?: string;
}

/**
 * The function a sidecar default-exports. May be sync or async — async
 * is useful for detectors that need to read the target file from disk
 * (e.g. file-length, which must compute post-edit line count).
 */
export type DetectFn = (
  input: DetectInput,
) =>
  | Violation[]
  | null
  | Promise<Violation[] | null>;

/** A loaded detector with its paired rule markdown path and content. */
export interface Detector {
  readonly name: string;
  readonly rulePath: string;
  /**
   * Content of the paired `.md` rule file. Loaded at session start and
   * inlined into the PreToolUse nudge when the detector fires, so the
   * model sees the full rationale at the moment of violation rather than
   * needing to spend a tool call to go fetch it. `null` when the markdown
   * is missing or unreadable — the nudge still shows the violation, just
   * without the rule body.
   */
  readonly ruleContent: string | null;
  readonly detect: DetectFn;
}

/**
 * Load all `*.detect.ts` sidecars under `<projectPath>/.claude/rules/`.
 *
 * Each sidecar is dynamically imported; its default export must be a
 * function. Failures to load or invalid shapes are logged and skipped —
 * one broken detector never brings down the others.
 */
export const loadRuleDetectors = async (projectPath: string) => {
  const rulesDir = pathJoin(projectPath, ".claude/rules");
  const detectors: Detector[] = [];

  const candidates = await collectDetectFiles(rulesDir);
  for (const rel of candidates) {
    const abs = pathJoin(rulesDir, rel);
    const detector = await loadDetector(abs, projectPath);
    if (detector) detectors.push(detector);
  }
  logger.info(
    "loaded %d rule detectors from %s",
    detectors.length,
    rulesDir,
  );
  return detectors;
};

const collectDetectFiles = async (rulesDir: string) => {
  const glob = new Glob("**/*.detect.ts");
  const matches: string[] = [];
  const drain = (async () => {
    for await (const match of glob.scan({ cwd: rulesDir })) {
      matches.push(match);
    }
  })();
  return drain.then(
    () => matches,
    (err) => {
      logger.debug("no rule detectors at %s: %s", rulesDir, errMessage(err));
      return [];
    },
  );
};

const loadDetector = async (abs: string, projectPath: string) => {
  const mod = await import(abs).catch((err) => {
    logger.warn("failed to import detector %s: %s", abs, errMessage(err));
    return null;
  });
  if (!mod) return null;
  const fn = (mod as { default?: unknown }).default;
  if (typeof fn !== "function") {
    logger.warn(
      "detector %s has no default-exported function",
      abs,
    );
    return null;
  }
  const name = pathBasename(abs, ".detect.ts");
  const ruleAbsPath = pathJoin(pathDirname(abs), `${name}.md`);
  const ruleContent = await Bun.file(ruleAbsPath)
    .text()
    .catch((err) => {
      logger.debug(
        "paired rule markdown missing for detector %s: %s",
        name,
        errMessage(err),
      );
      return null;
    });
  return {
    name,
    rulePath: pathRelative(projectPath, ruleAbsPath),
    ruleContent,
    detect: fn as DetectFn,
  };
};

/** Tool names that carry file edits worth scanning. */
const FILE_EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Extract `{ filePath, content }` from a tool input when possible. */
export const extractEditTarget = (
  toolName: string,
  toolInput: Record<string, unknown>,
) => {
  if (!FILE_EDIT_TOOLS.has(toolName)) return { filePath: undefined, content: undefined };
  const filePath =
    typeof toolInput.file_path === "string" ? toolInput.file_path : undefined;
  if (toolName === "Edit") {
    const content =
      typeof toolInput.new_string === "string" ? toolInput.new_string : undefined;
    return { filePath, content };
  }
  if (toolName === "Write") {
    const content =
      typeof toolInput.content === "string" ? toolInput.content : undefined;
    return { filePath, content };
  }
  // MultiEdit has an `edits` array; concatenate new_strings for scanning.
  if (toolName === "MultiEdit" && Array.isArray(toolInput.edits)) {
    const parts: string[] = [];
    for (const edit of toolInput.edits) {
      if (
        edit &&
        typeof edit === "object" &&
        "new_string" in edit &&
        typeof (edit as { new_string: unknown }).new_string === "string"
      ) {
        parts.push((edit as { new_string: string }).new_string);
      }
    }
    return { filePath, content: parts.join("\n") };
  }
  return { filePath, content: undefined };
};

/** Run every detector against a tool call; collect findings per rule. */
export const runDetectors = async (
  detectors: readonly Detector[],
  toolName: string,
  toolInput: Record<string, unknown>,
) => {
  const { filePath, content } = extractEditTarget(toolName, toolInput);
  const input: DetectInput = { toolName, toolInput, filePath, content };

  const results = await Promise.all(
    detectors.map(async (detector) => ({
      detector,
      violations: (await safeDetect(detector, input)) ?? [],
    })),
  );
  return results.filter((r) => r.violations.length > 0);
};

const safeDetect = (detector: Detector, input: DetectInput) =>
  Promise.resolve()
    .then(() => detector.detect(input) ?? null)
    .catch((err) => {
      logger.warn("detector %s threw: %s", detector.name, errMessage(err));
      return null;
    });

/**
 * Format findings as an `additionalContext` nudge for the model.
 *
 * Each violating rule's full markdown content (when available) is inlined
 * so the model reads the remediation guidance at the moment of violation
 * rather than relying on it to spend a tool call going back to the file.
 * The rule is the source of truth on how to fix — the detector only flags.
 */
export const formatFindings = (
  findings: ReadonlyArray<{ detector: Detector; violations: readonly Violation[] }>,
) => {
  if (findings.length === 0) return null;
  const blocks = findings.map(({ detector, violations }) => {
    const header = `Rule: ${detector.name} (${detector.rulePath})`;
    const bullets = violations.map((v) => {
      const prefix = v.line ? `Line ${v.line}: ` : "";
      const suffix = v.snippet ? ` — \`${v.snippet}\`` : "";
      return `  - ${prefix}${v.message}${suffix}`;
    });
    const ruleBlock = detector.ruleContent
      ? ["", "--- rule content ---", detector.ruleContent.trim(), "--- end rule ---"]
      : [];
    return [header, ...bullets, ...ruleBlock].join("\n");
  });
  return [
    "⚠️ Rule violations detected in your pending edit. Review the rule content below before committing:",
    "",
    blocks.join("\n\n"),
    "",
    "Amend the edit to comply, or explain why the violation is warranted before proceeding.",
  ].join("\n");
};

/**
 * Build a `PreToolUse` hook callback that runs every detector and returns
 * violations as `additionalContext`. Never blocks — findings are advisory.
 *
 * The returned structure slots directly into SDK `Options.hooks.PreToolUse`.
 */
export const buildRuleHook = (detectors: readonly Detector[]) => {
  // Matches the SDK's HookCallback signature: (input, toolUseID, options).
  // We only read `input`; the other params are accepted to fit the contract.
  const hook = async (
    input: unknown,
    _toolUseID: string | undefined,
    _options: { signal: AbortSignal },
  ) => {
    // Defensive shape check — hooks receive a tagged union. We only care
    // about PreToolUse; other events funnel through safely with no action.
    const evt = input as {
      hook_event_name?: string;
      tool_name?: string;
      tool_input?: unknown;
    };
    if (evt?.hook_event_name !== "PreToolUse") {
      return { hookSpecificOutput: { hookEventName: "PreToolUse" as const } };
    }
    const toolName = typeof evt.tool_name === "string" ? evt.tool_name : "";
    const toolInput =
      evt.tool_input && typeof evt.tool_input === "object"
        ? (evt.tool_input as Record<string, unknown>)
        : {};
    const findings = await runDetectors(detectors, toolName, toolInput);
    const context = formatFindings(findings);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        ...(context ? { additionalContext: context } : {}),
      },
    };
  };
  return [{ hooks: [hook] }];
};
