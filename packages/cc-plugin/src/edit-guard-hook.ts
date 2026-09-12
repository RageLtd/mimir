/**
 * Edit guard — PreToolUse:Bash hook.
 *
 * Claude Code's auto permission mode tells the model to prefer Bash
 * (sed, heredocs, short scripts) over the Read/Edit/Write tools. That
 * costs the developer the one thing they watch the chat for: edits shown
 * as diffs. This hook gives auto mode back its edit tools without giving
 * up the rest of it.
 *
 *   single — the command rewrites exactly one explicit file through the
 *            shell. Denied, with a reason pointing at the Edit tool.
 *   bulk   — the command fans out over many files (globs, find/xargs,
 *            loops, multiple paths, glob()/os.walk in a script). Allowed;
 *            the model is asked to report the change set afterwards
 *            because nothing of it shows in chat.
 *   none   — not an edit, or too ambiguous to call. Silent.
 *
 * Hooks fire before the permission-mode check in every mode, so a deny
 * here is honoured even under auto. The classifier errs toward `none`:
 * blocking a legitimate command is the worse failure. Disable per
 * session with MIMIR_EDIT_GUARD=0.
 */

import { errMessage } from "@mimir/plugin-core/util";
import { createLogger } from "./logger";

const log = createLogger("edit-guard-hook");

const assertNever = (x: never): never => {
  throw new Error(`Unhandled edit shape: ${String(x)}`);
};

export type EditShape = "none" | "single" | "bulk";

type HookInput = {
  readonly tool_name?: string;
  readonly tool_input?: unknown;
};

const HOOK_EVENT = "PreToolUse";
const GUARD_ENV = "MIMIR_EDIT_GUARD";

/** Paths whose writes are scratch, not edits. */
const SCRATCH_TARGET = /^(\/dev\/|\/tmp\/|\/private\/tmp\/|\/var\/folders\/)/;

/** Anything that makes one command touch many files. */
const FAN_OUT =
  /\bxargs\b|\bfind\s|\bgit\s+ls-files\b|\b(?:grep|rg)\s+(?:-\w*l\w*\s)|\bfor\s+\w+\s+in\b|\bwhile\s+(?:IFS=\S*\s+)?read\b|\bglob\b|\brglob\b|\bos\.walk\b|\breaddir(?:Sync)?\b|\bDir\.glob\b|\bFile::Find\b/;

const WILDCARD = /[*?]|\{[^}]*,[^}]*\}/;

/**
 * Split a command line into simple commands on `|`, `||`, `&&`, `;` and
 * newlines — but only outside quotes, so a `;` or newline inside a
 * `python -c "..."` body stays with its interpreter.
 */
export const splitSegments = (command: string) => {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] ?? "";
    if (quote) {
      current += ch;
      if (ch === "\\" && quote === '"' && i + 1 < command.length)
        current += command[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[++i];
    } else if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
      segments.push(current);
      current = "";
      if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
    } else current += ch;
  }
  segments.push(current);
  return segments;
};

const HEREDOC =
  /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\n|$)/g;

const INLINE_SCRIPT_CMD = /^(?:python3?|node|ruby|perl)\b/;
const INLINE_SCRIPT_FLAG = /\s-(?:c|e)\s+/;

/** Write calls inside python/node/ruby/perl snippets. */
const SCRIPT_WRITES =
  /\bopen\((?:[^()]|\([^()]*\))*['"][wa]\+?b?['"]|\.write_text\(|\.write_bytes\(|\bwriteFile(?:Sync)?\(|\bFile\.(?:write|open\([^)]*['"][wa]['"])|\bopen\((?:my\s+)?\$\w+,\s*['"]>>?['"]/;

/** String literals that look like file paths (have an extension or a slash). */
const SCRIPT_PATH_LITERAL =
  /['"]((?:~|\.{1,2})?\/?(?:[\w@.+-]+\/)*[\w@+-]+\.[A-Za-z0-9]{1,8})['"]/g;

const PATH_TOKEN =
  /^(?:~|\.{1,2})?\/?(?:[\w@.+-]+\/)*[\w@+-]+(?:\.[A-Za-z0-9]{1,8})?$/;

/**
 * Split a simple command into shell words, keeping quoted runs together
 * and stripping the quotes. Good enough for classification; not a shell.
 */
export const shellWords = (segment: string) => {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let hasWord = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i] ?? "";
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
        current += segment[++i];
      } else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasWord = true;
    } else if (ch === "\\" && i + 1 < segment.length) {
      current += segment[++i];
      hasWord = true;
    } else if (/\s/.test(ch)) {
      if (hasWord) words.push(current);
      current = "";
      hasWord = false;
    } else {
      current += ch;
      hasWord = true;
    }
  }
  if (hasWord) words.push(current);
  return words;
};

const isPathLike = (word: string) =>
  !word.startsWith("-") &&
  !word.startsWith("$") &&
  (word.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(word)) &&
  (PATH_TOKEN.test(word) || WILDCARD.test(word));

const isScratch = (path: string) => SCRATCH_TARGET.test(path);

type Targets = { readonly paths: string[]; readonly wildcard: boolean };

const collectTargets = (words: readonly string[]): Targets => {
  const paths: string[] = [];
  let wildcard = false;
  for (const w of words) {
    if (!isPathLike(w) || isScratch(w)) continue;
    if (WILDCARD.test(w)) wildcard = true;
    else paths.push(w);
  }
  return { paths, wildcard };
};

/** sed -i / perl -pi: flags, then the expression, then the targets. */
const inPlaceTargets = (words: readonly string[]) => {
  const [cmd, ...rest] = words;
  if (!cmd) return null;
  const isSed = /^sed$/.test(cmd);
  const isPerl = /^perl$/.test(cmd);
  if (!isSed && !isPerl) return null;
  const inPlace = rest.some(
    (w) => /^-[A-Za-z]*i/.test(w) || w.startsWith("--in-place"),
  );
  if (!inPlace) return null;
  const operands: string[] = [];
  let expressionSeen = false;
  for (let i = 0; i < rest.length; i++) {
    const w = rest[i] ?? "";
    // macOS `sed -i '' expr file`: the empty word is the backup suffix.
    if (w === "") continue;
    if (w.startsWith("-")) {
      // Flags that consume the next word: -e/--expression (the script),
      // -f/--file (a script file). A trailing `e` in a flag cluster
      // (-ne, -pe) is the same as -e. Plain -E is a regex flag, no arg.
      if (w === "-f" || w === "--file") i++;
      else if (w === "-e" || w === "--expression" || /^-[A-Za-z]*e$/.test(w)) {
        expressionSeen = true;
        i++;
      }
      continue;
    }
    if (!expressionSeen) {
      // sed's first operand is the script; perl -pi without -e reads a
      // script file first.
      expressionSeen = true;
      continue;
    }
    operands.push(w);
  }
  return collectTargets(operands);
};

/** `> file`, `>> file`, `tee file`, `tee -a file`. */
const redirectTargets = (segment: string, words: readonly string[]) => {
  const paths: string[] = [];
  let wildcard = false;
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const word = shellWords(raw)[0] ?? "";
    if (!word || word.startsWith("&") || !isPathLike(word) || isScratch(word))
      return;
    if (WILDCARD.test(word)) wildcard = true;
    else paths.push(word);
  };
  // Redirects: ignore fd-prefixed stderr logging (2>file) and &>. Quoted
  // text is blanked first so a `>` inside an awk/python snippet doesn't
  // read as a redirect — except a quoted word right after `>`, which is
  // the target itself.
  const visible = segment.replace(
    /(>\s*)?("[^"]*"|'[^']*')/g,
    (m, pre: string | undefined) => (pre ? m : '""'),
  );
  for (const m of visible.matchAll(
    /(?<![\d&<])>{1,2}\s*((?:"[^"]*"|'[^']*'|\S)+)/g,
  )) {
    add(m[1]);
  }
  const teeAt = words.indexOf("tee");
  if (teeAt !== -1) {
    for (const w of words.slice(teeAt + 1)) {
      if (w.startsWith("-")) continue;
      add(w);
    }
  }
  return { paths, wildcard };
};

/** Inline interpreter snippets: -c/-e argument or heredoc body. */
const scriptTargets = (
  words: readonly string[],
  segment: string,
  heredocBodies: readonly string[],
) => {
  const cmd = words[0] ?? "";
  if (!INLINE_SCRIPT_CMD.test(cmd)) return null;
  let body: string | null = null;
  if (INLINE_SCRIPT_FLAG.test(segment)) {
    const at = words.findIndex((w) => w === "-c" || w === "-e");
    body = at !== -1 ? (words[at + 1] ?? null) : null;
  } else if (heredocBodies.length > 0 && /<<|\s-\s*$|\s-\s*<</.test(segment)) {
    body = heredocBodies.join("\n");
  }
  if (body === null) return null;
  if (!SCRIPT_WRITES.test(body))
    return { paths: [], wildcard: false, write: false };
  const paths: string[] = [];
  for (const m of body.matchAll(SCRIPT_PATH_LITERAL)) {
    const p = m[1] ?? "";
    if (p && !isScratch(p) && !paths.includes(p)) paths.push(p);
  }
  return { paths, wildcard: FAN_OUT.test(body), write: true };
};

const shapeFor = (targets: Targets, fanOut: boolean): EditShape => {
  if (targets.wildcard || fanOut || targets.paths.length > 1) return "bulk";
  if (targets.paths.length === 1) return "single";
  return "none";
};

export type Classification = {
  readonly shape: EditShape;
  /** The single target when shape is "single". */
  readonly target?: string;
};

/**
 * Classify a Bash command by how it edits files. Pure; never throws for
 * string input — malformed shell falls to "none".
 */
export const classifyBashEdit = (command: string): Classification => {
  const heredocBodies: string[] = [];
  const stripped = command.replace(HEREDOC, (_m, _q, _tag, body: string) => {
    heredocBodies.push(body);
    return " <<HEREDOC_BODY";
  });
  // Fan-out is judged on the command's own words, not on text inside
  // quotes (a sed expression mentioning "find" is not a find pipeline).
  const fanOut = FAN_OUT.test(stripped.replace(/"[^"]*"|'[^']*'/g, '""'));
  let bulk = false;
  const singles = new Set<string>();
  const consider = (targets: Targets, localFanOut = false) => {
    const shape = shapeFor(targets, fanOut || localFanOut);
    if (shape === "bulk") bulk = true;
    else if (shape === "single") singles.add(targets.paths[0] ?? "");
  };
  for (const segment of splitSegments(stripped)) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const words = shellWords(trimmed);
    const inPlace = inPlaceTargets(words);
    if (inPlace) consider(inPlace);
    const script = scriptTargets(words, trimmed, heredocBodies);
    if (script?.write) consider(script, script.wildcard);
    consider(redirectTargets(trimmed, words));
    if (bulk) break;
  }
  // Several one-file writes in one command are a bulk change too.
  if (bulk || singles.size > 1) return { shape: "bulk" };
  const [target] = singles;
  return target ? { shape: "single", target } : { shape: "none" };
};

const denyReason = (target: string) =>
  `Mimir edit guard: this command rewrites a single file (${target}) through the shell. Make the change with the Edit tool (or Write for a new file) so the developer sees it as a diff in chat. Shell edits are for mechanical changes across many files.`;

const BULK_CONTEXT =
  "Mimir edit guard: bulk shell edit allowed. The developer cannot see these changes in chat — after it runs, report what changed with `git diff --stat` and show one representative hunk.";

/**
 * Hook decision for a Bash command: the JSON object to print, or null
 * for silence. Separated from I/O so it can be tested directly.
 */
export const decide = (command: string) => {
  const { shape, target } = classifyBashEdit(command);
  switch (shape) {
    case "single":
      return {
        hookSpecificOutput: {
          hookEventName: HOOK_EVENT,
          permissionDecision: "deny",
          permissionDecisionReason: denyReason(target ?? "that file"),
        },
      };
    case "bulk":
      return {
        hookSpecificOutput: {
          hookEventName: HOOK_EVENT,
          additionalContext: BULK_CONTEXT,
        },
      };
    case "none":
      return null;
    default:
      return assertNever(shape);
  }
};

const readStdin = async () => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const parseCommand = (raw: string) => {
  if (raw.trim().length === 0) return null;
  // Serialisation boundary: the hook payload arrives as untyped JSON.
  const parsed = (() => {
    try {
      return JSON.parse(raw) as HookInput;
    } catch {
      return null;
    }
  })();
  if (parsed?.tool_name !== "Bash") return null;
  const input = parsed.tool_input;
  if (!input || typeof input !== "object" || !("command" in input)) return null;
  return typeof input.command === "string" ? input.command : null;
};

/**
 * Entry point for `mimir-cc edit-guard`. Always exits 0: a crashing hook
 * would block every Bash call, which is far worse than a missed edit.
 */
export const runEditGuardHook = async () => {
  if (process.env.MIMIR_ACTIVE !== "1") return 0;
  if (process.env[GUARD_ENV] === "0") return 0;

  const raw = await readStdin().catch((err) => {
    log.error("stdin read failed", { error: errMessage(err) });
    return "";
  });
  const command = parseCommand(raw);
  if (command === null) return 0;

  const decision = decide(command);
  if (!decision) return 0;
  log.info("edit guard fired", {
    shape:
      "permissionDecision" in decision.hookSpecificOutput ? "single" : "bulk",
  });
  process.stdout.write(JSON.stringify(decision));
  return 0;
};
