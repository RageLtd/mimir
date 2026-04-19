/**
 * Rule-detect hooks — mechanical enforcement of project rules.
 *
 * Contract: any rule at `.claude/rules/<path>/<name>.md` may ship an
 * optional sidecar `.claude/rules/<path>/<name>.detect.ts`. The sidecar
 * default-exports a function that returns violations for a pending tool
 * call; mimir runs it inside a PreToolUse hook and — when any fire —
 * injects a short reminder as `additionalContext` so the model sees the
 * violation before the edit is committed.
 *
 * The sidecar is opt-in and ignored by standard Claude Code, which only
 * reads the markdown.
 *
 * Sidecar shape (no imports required):
 *
 *   export default (ctx) => [ { message, line?, snippet? }, ... ];
 *
 * The paired `.md` frontmatter declares when the detector runs:
 *
 *   ---
 *   globs: ["*.ts", "*.tsx", "*.mts", "*.mjs"]
 *   tools: ["Edit", "Write", "MultiEdit"]
 *   ---
 *
 * - `globs`: file path patterns; if missing/empty, matches any path.
 * - `tools`: tool names to run on; if missing/empty, defaults to the
 *   file-edit tools (Edit, Write, MultiEdit, NotebookEdit).
 *
 * Rule-hooks handles tool filtering, file filtering, and content
 * extraction. Detectors focus solely on the detection logic.
 */

import { Glob } from "bun";
import { errMessage } from "../../util";
import { createChildLogger, log } from "../../utils/log";

// Minimal path helpers — avoid the node:path import for four calls.
const pathJoin = (...parts: string[]) =>
  parts
    .filter((p) => p.length > 0)
    .map((p, i) =>
      i === 0 ? p.replace(/\/+$/, "") : p.replace(/^\/+|\/+$/g, ""),
    )
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
  while (
    i < fromParts.length &&
    i < toParts.length &&
    fromParts[i] === toParts[i]
  ) {
    i++;
  }
  const up = Array(fromParts.length - i).fill("..");
  return [...up, ...toParts.slice(i)].join("/");
};

const logger = createChildLogger(log, "rule-hooks");

/** A single rule violation. Rules own the wording of `message`. */
export interface Violation {
  readonly message: string;
  readonly line?: number;
  readonly snippet?: string;
}

/**
 * Input handed to every detect function. The design is minimal on purpose
 * — we pass the raw hook event and the target file path (extracted for
 * convenience), and let the detector decide what to do with them. No
 * content pre-extraction, no disk-read helpers; detectors read what they
 * need via `Bun.file` or by inspecting `hookEvent.tool_input` directly.
 *
 * The paired `.md` frontmatter declares when the detector fires via
 * `globs` (file path patterns) and `tools` (tool names). Rule-hooks
 * filters BEFORE calling detect — if this function runs, the tool and
 * file already matched the detector's declared scope.
 */
export interface RuleDetectionInput {
  /**
   * The raw hook event from the Claude Agent SDK. For PreToolUse this
   * carries `hook_event_name`, `tool_name`, and `tool_input`. Extract
   * what you need — nothing is pre-parsed.
   */
  readonly hookEvent: Record<string, unknown>;
  /**
   * Path to the file the tool is operating on, extracted from the tool
   * input when a file is involved. Undefined for tools like `Bash` that
   * don't target a specific file.
   */
  readonly filePath?: string;
}

/**
 * The function a sidecar default-exports. Sync or async. Returning
 * an empty array or null means "no violation".
 */
export type DetectFn = (
  input: RuleDetectionInput,
) => Violation[] | null | Promise<Violation[] | null>;

/** A loaded detector with its paired rule markdown metadata. */
export interface Detector {
  readonly name: string;
  readonly rulePath: string;
  /** Content of the paired `.md` file — inlined into the nudge on violation. */
  readonly ruleContent: string | null;
  /**
   * File globs parsed from the paired `.md` frontmatter. Empty means
   * "any path"; detectors that don't set globs will run on all files.
   */
  readonly globs: readonly string[];
  /**
   * Tool names parsed from the paired `.md` frontmatter. Empty means
   * "default to file-edit tools" (Edit/Write/MultiEdit/NotebookEdit) —
   * preserves the common-case behaviour without explicit declaration.
   */
  readonly tools: readonly string[];
  readonly detect: DetectFn;
}

// ── Frontmatter parsing ──

/**
 * Extract a string array from YAML-ish frontmatter. Supports the common
 * inline-array form `key: ["a", "b"]` — we don't pull in a YAML parser
 * since that's all the rule files need.
 */
const parseStringArray = (body: string, key: string) => {
  const re = new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "m");
  const m = body.match(re);
  if (!m) return [];
  const contents = m[1] ?? "";
  const strings: string[] = [];
  const strRe = /"([^"]*)"|'([^']*)'/g;
  for (const match of contents.matchAll(strRe)) {
    strings.push(match[1] ?? match[2] ?? "");
  }
  return strings.filter(Boolean);
};

const parseFrontmatter = (md: string | null) => {
  if (!md) return { globs: [] as string[], tools: [] as string[] };
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { globs: [] as string[], tools: [] as string[] };
  const body = match[1] ?? "";
  return {
    globs: parseStringArray(body, "globs"),
    tools: parseStringArray(body, "tools"),
  };
};

// ── Matching ──

/** Default tool set for detectors that don't declare `tools:` explicitly. */
const DEFAULT_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

const matchesTool = (tools: readonly string[], toolName: string) => {
  const effective = tools.length === 0 ? DEFAULT_TOOLS : tools;
  return effective.includes(toolName);
};

/**
 * Match a glob against a file path. Patterns without `/` are treated as
 * basename matches anywhere in the tree (e.g. `package.json` matches
 * `/any/path/to/package.json`).
 */
const matchesGlob = (pattern: string, filePath: string) => {
  const effective = pattern.includes("/") ? pattern : `**/${pattern}`;
  return new Glob(effective).match(filePath);
};

const matchesAnyGlob = (globs: readonly string[], filePath: string) => {
  if (globs.length === 0) return true;
  return globs.some((g) => matchesGlob(g, filePath));
};

// ── Loading ──

/**
 * Load all `*.detect.ts` sidecars under `<projectPath>/.claude/rules/`.
 */
export const loadRuleDetectors = async (projectPath: string) => {
  const rulesDir = pathJoin(projectPath, ".claude/rules");
  const detectors: Detector[] = [];

  const candidates = await collectDetectFiles(rulesDir);
  if (candidates.length > 0) {
    await ensureHelpersFile(rulesDir);
  }
  for (const rel of candidates) {
    const abs = pathJoin(rulesDir, rel);
    const detector = await loadDetector(abs, projectPath);
    if (detector) detectors.push(detector);
  }
  logger.info("loaded %d rule detectors from %s", detectors.length, rulesDir);
  return detectors;
};

/**
 * Canonical content of `.claude/rules/detection-helpers.ts`. Written at
 * session start when any detectors are present so sidecar authors can
 * `import { ... } from "../detection-helpers"` without needing to know
 * what shape this version of mimir speaks. Changes here ripple to every
 * project that uses mimir, so additions should be additive.
 */
const HELPERS_FILE_CONTENT = `/**
 * Rule-detect sidecar types and helpers.
 *
 * This file is managed by mimir-acp — it's (re)written at session start
 * to mirror whatever version of mimir is running. Feel free to commit it
 * or .gitignore it as you prefer; mimir will keep it in sync either way.
 *
 * User-authored helpers should go in a separate file — mimir overwrites
 * this one whenever its canonical content changes.
 *
 * Sidecars (\`.claude/rules/**\\/*.detect.ts\`) can import from this file:
 *
 *   import {
 *     getIncomingContent,
 *     getToolInput,
 *     scanLines,
 *     type RuleDetectionInput,
 *     type Violation,
 *   } from "../detection-helpers";
 *
 *   const RETURN_TYPE = /\\)\\s*:\\s*[A-Za-z]+\\s*(=>|\\{)/;
 *
 *   export default (input: RuleDetectionInput) => {
 *     const content = getIncomingContent(getToolInput(input));
 *     if (!content) return [];
 *     return scanLines(content, RETURN_TYPE, "explicit return type");
 *   };
 *
 * Importing is optional — detectors can build their own extraction
 * logic. These exist purely to spare you the boilerplate.
 */

// ── Types ──

/** A single rule violation found by a detector. */
export interface Violation {
  /** Short human-readable description of what's wrong. */
  readonly message: string;
  /** Optional 1-indexed line number where the violation occurs. */
  readonly line?: number;
  /** Optional code snippet highlighting the offending text. */
  readonly snippet?: string;
}

/**
 * Input handed to every detect function.
 *
 * File-path and tool-name scoping is declared in the paired \`.md\`
 * frontmatter (\`globs\` and \`tools\`) and enforced by mimir BEFORE the
 * detector is invoked — so if your function runs, the scope matched.
 */
export interface RuleDetectionInput {
  /**
   * Raw hook event from the Claude Agent SDK. For PreToolUse this
   * carries \`hook_event_name\`, \`tool_name\`, and \`tool_input\`. Nothing
   * is pre-parsed — inspect it however you need.
   */
  readonly hookEvent: Record<string, unknown>;
  /**
   * Path to the file this tool is operating on, extracted from the
   * tool input when a file is involved. Undefined for tools like
   * \`Bash\` that don't target a specific file.
   */
  readonly filePath?: string;
}

// ── Helpers ──

/** Narrow \`input.hookEvent.tool_input\` to a Record<string, unknown>. */
export const getToolInput = (input: RuleDetectionInput) =>
  (input.hookEvent.tool_input ?? {}) as Record<string, unknown>;

/**
 * Pull the incoming file content from an Edit / Write / MultiEdit tool
 * input. Returns:
 *   - \`toolInput.new_string\` for Edit
 *   - \`toolInput.content\` for Write
 *   - concatenated \`new_string\` values for MultiEdit
 *   - \`null\` when the tool doesn't carry inbound content (e.g. Bash)
 *
 * Intended for detectors that scan "what's about to land in the file"
 * without caring which edit tool produced it. Detectors that need
 * post-edit file state should read from disk with \`Bun.file\` directly.
 */
export const getIncomingContent = (toolInput: Record<string, unknown>) => {
  if (typeof toolInput.new_string === "string") return toolInput.new_string;
  if (typeof toolInput.content === "string") return toolInput.content;
  if (Array.isArray(toolInput.edits)) {
    const parts: string[] = [];
    for (const e of toolInput.edits) {
      if (
        e &&
        typeof e === "object" &&
        typeof (e as { new_string?: unknown }).new_string === "string"
      ) {
        parts.push((e as { new_string: string }).new_string);
      }
    }
    return parts.join("\\n");
  }
  return null;
};

/**
 * Line-by-line regex scan. Emits one violation per matching line, with
 * the matched text captured as \`snippet\`. Uses \`message\` as-is for every
 * violation — the rule markdown content inlined in the nudge carries
 * the detail, so detector messages can stay terse.
 *
 * Detectors that need variable snippet shaping or multiline patterns
 * should loop themselves instead of using this helper.
 */
export const scanLines = (
  content: string,
  pattern: RegExp,
  message: string,
) => {
  const violations: Violation[] = [];
  const lines = content.split("\\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const match = pattern.exec(line);
    if (!match) continue;
    violations.push({
      message,
      line: i + 1,
      snippet: match[0].trim(),
    });
  }
  return violations;
};

/** True for .d.ts declaration files. */
export const isDeclarationFile = (filePath?: string) =>
  filePath?.endsWith(".d.ts") ?? false;

/**
 * True for \`*.test.*\` and \`*.spec.*\` across common JS/TS extensions.
 * Detectors whose rules don't apply to test code (e.g. try/catch in
 * async rejection assertions) use this to early-return.
 */
export const isTestFile = (filePath?: string) =>
  filePath ? /\\.(test|spec)\\.(ts|tsx|mts|mjs|js|jsx)$/.test(filePath) : false;
`;

/**
 * Ensure `.claude/rules/detection-helpers.ts` exists and matches the
 * current canonical content. Skips the write when the file is already
 * in sync — avoids touching mtime unnecessarily in editors that watch
 * the rules directory.
 */
const ensureHelpersFile = async (rulesDir: string) => {
  const helpersPath = pathJoin(rulesDir, "detection-helpers.ts");
  const file = Bun.file(helpersPath);
  const exists = await file.exists();
  if (exists) {
    const current = await file.text().catch(() => "");
    if (current === HELPERS_FILE_CONTENT) return;
  }
  await Bun.write(helpersPath, HELPERS_FILE_CONTENT).catch((err) => {
    logger.warn(
      "failed to write detection-helpers file at %s: %s",
      helpersPath,
      errMessage(err),
    );
  });
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
    logger.warn("detector %s has no default-exported function", abs);
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
  const { globs, tools } = parseFrontmatter(ruleContent);
  return {
    name,
    rulePath: pathRelative(projectPath, ruleAbsPath),
    ruleContent,
    globs,
    tools,
    detect: fn as DetectFn,
  };
};

// ── Running ──

/** Extract a `file_path` field from an arbitrary tool_input record. */
const extractFilePath = (toolInput: Record<string, unknown>) =>
  typeof toolInput.file_path === "string" ? toolInput.file_path : undefined;

/** Run every detector against a hook event; collect findings per rule. */
export const runDetectors = async (
  detectors: readonly Detector[],
  hookEvent: Record<string, unknown>,
) => {
  const toolName =
    typeof hookEvent.tool_name === "string" ? hookEvent.tool_name : "";
  const toolInput =
    hookEvent.tool_input && typeof hookEvent.tool_input === "object"
      ? (hookEvent.tool_input as Record<string, unknown>)
      : {};
  const filePath = extractFilePath(toolInput);

  const results = await Promise.all(
    detectors.map(async (detector) => {
      // Tool scope — skip if this detector doesn't apply to the current tool.
      if (!matchesTool(detector.tools, toolName)) {
        return { detector, violations: [] as Violation[] };
      }
      // File scope — skip if filePath is present but doesn't match any glob.
      // Detectors that target non-file tools (like Bash) shouldn't have globs;
      // if they do and filePath is absent, we skip conservatively.
      if (detector.globs.length > 0) {
        if (!filePath || !matchesAnyGlob(detector.globs, filePath)) {
          return { detector, violations: [] as Violation[] };
        }
      }

      const input: RuleDetectionInput = { hookEvent, filePath };
      const violations = (await safeDetect(detector, input)) ?? [];
      return { detector, violations };
    }),
  );
  return results.filter((r) => r.violations.length > 0);
};

const safeDetect = (detector: Detector, input: RuleDetectionInput) =>
  Promise.resolve()
    .then(() => detector.detect(input) ?? null)
    .catch((err) => {
      logger.warn("detector %s threw: %s", detector.name, errMessage(err));
      return null;
    });

// ── Formatting ──

/**
 * Format findings as an `additionalContext` nudge for the model.
 *
 * Each violating rule's full markdown content (when available) is inlined
 * so the model reads the remediation guidance at the moment of violation.
 */
export const formatFindings = (
  findings: ReadonlyArray<{
    detector: Detector;
    violations: readonly Violation[];
  }>,
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
      ? [
          "",
          "--- rule content ---",
          detector.ruleContent.trim(),
          "--- end rule ---",
        ]
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

// ── PreToolUse hook ──

export const buildRuleHook = (detectors: readonly Detector[]) => {
  const hook = async (
    input: unknown,
    _toolUseID: string | undefined,
    _options: { signal: AbortSignal },
  ) => {
    const evt = input as {
      hook_event_name?: string;
      tool_name?: string;
      tool_input?: unknown;
    };
    if (evt?.hook_event_name !== "PreToolUse") {
      return { hookSpecificOutput: { hookEventName: "PreToolUse" as const } };
    }
    const findings = await runDetectors(
      detectors,
      evt as Record<string, unknown>,
    );
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
