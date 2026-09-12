/**
 * Project rules reader — the prose half of the rules system.
 *
 * Reads convention files from a project: the root files (CLAUDE.md,
 * AGENTS.md, .cursorrules) and every markdown file under .claude/rules/.
 * Claude Code loads these itself; every other host Mimir runs on gets
 * them through this module so the same rules apply on every platform.
 *
 * Two Claude Code behaviours are reproduced so the rules mean the same
 * thing everywhere:
 *   - A rule with `paths:` frontmatter is path-scoped. It is left out of
 *     the always-on block and surfaced only when a file matching one of
 *     its globs is read (`scopedRulesFor`). Matching is gitignore-style,
 *     which is what Claude Code does in practice: a pattern without a
 *     slash (`*.ts`) matches the basename at any depth; a pattern with a
 *     slash (`src/api/**\/*.ts`) matches the project-relative path.
 *   - Frontmatter never reaches the model; only the body does.
 *
 * Root files are deduplicated by real path, so a CLAUDE.md symlinked to
 * AGENTS.md is read once. Hosts that already load AGENTS.md natively
 * (OpenCode, Codex) pass `includeRootFiles: false` and receive only the
 * rules directory.
 */

import { realpath, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Glob } from "bun";
import type { Logger } from "../logger";

/** One rules file. `paths` is present only for path-scoped rules. */
export type ProjectRulesEntry = {
  readonly path: string;
  readonly content: string;
  readonly paths?: readonly string[];
};

export type ReadProjectRulesOptions = {
  /** Read CLAUDE.md / AGENTS.md / .cursorrules too. Default true. */
  readonly includeRootFiles?: boolean;
  readonly log?: Logger;
};

const ROOT_FILES = ["CLAUDE.md", ".cursorrules", "AGENTS.md"];
const RULES_DIR = ".claude/rules";
const RULES_GLOB = "**/*.md";

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

const unquote = (raw: string) => raw.trim().replace(/^(['"])(.*)\1$/, "$2");

/**
 * Pull `paths:` out of a YAML frontmatter block. Handles the two shapes
 * rule files use — an inline list (`paths: ["a", "b"]`) and a block
 * list (`paths:` followed by `- a` lines). Anything else yields no
 * paths, which makes the rule always-on rather than silently dropped.
 */
const parsePaths = (frontmatter: string) => {
  const lines = frontmatter.split(/\r?\n/);
  const at = lines.findIndex((l) => /^paths\s*:/.test(l));
  if (at === -1) return undefined;
  const inline = lines[at]?.replace(/^paths\s*:/, "").trim() ?? "";
  if (inline.startsWith("[")) {
    const inner = inline.replace(/^\[/, "").replace(/\]\s*$/, "");
    const items = inner
      .split(",")
      .map(unquote)
      .filter((s) => s.length > 0);
    return items.length > 0 ? items : undefined;
  }
  const items: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const m = line.match(/^\s+-\s+(.+)$/);
    if (!m) break;
    const item = unquote(m[1] ?? "");
    if (item) items.push(item);
  }
  return items.length > 0 ? items : undefined;
};

/** Split a rules file into its frontmatter-derived scope and its body. */
export const parseRuleFile = (raw: string) => {
  const m = raw.match(FRONTMATTER);
  if (!m) return { body: raw.trim(), paths: undefined };
  return {
    body: raw.slice(m[0].length).trim(),
    paths: parsePaths(m[1] ?? ""),
  };
};

const isDirectory = async (path: string) => {
  const s = await stat(path).catch(() => null);
  return s?.isDirectory() ?? false;
};

const toEntry = (path: string, raw: string) => {
  const { body, paths } = parseRuleFile(raw);
  if (!body) return null;
  return paths ? { path, content: body, paths } : { path, content: body };
};

/**
 * Read every project rules file. Returns [] when the project has none.
 * Read failures on individual files are logged and skipped so one bad
 * file never hides the rest.
 */
export const readProjectRules = async (
  projectPath: string,
  options: ReadProjectRulesOptions = {},
) => {
  const { includeRootFiles = true, log } = options;
  const entries: ProjectRulesEntry[] = [];
  const seenReal = new Set<string>();

  if (includeRootFiles) {
    for (const name of ROOT_FILES) {
      const filePath = `${projectPath}/${name}`;
      const file = Bun.file(filePath);
      if (!(await file.exists())) continue;
      const real = await realpath(filePath).catch(() => filePath);
      if (seenReal.has(real)) {
        log?.debug("project rules: skipping duplicate root file", {
          path: name,
          realPath: real,
        });
        continue;
      }
      seenReal.add(real);
      const raw = await file.text().catch((err: unknown) => {
        log?.warn("project rules: root file unreadable", {
          path: name,
          error: String(err),
        });
        return "";
      });
      const entry = toEntry(name, raw);
      if (entry) entries.push(entry);
    }
  }

  const rulesDir = `${projectPath}/${RULES_DIR}`;
  if (await isDirectory(rulesDir)) {
    const glob = new Glob(RULES_GLOB);
    const matches: string[] = [];
    for await (const match of glob.scan({
      cwd: rulesDir,
      followSymlinks: true,
    }))
      matches.push(match);
    // Stable order so the injected block is byte-identical across runs
    // (it sits in a cached prompt prefix on some hosts).
    matches.sort();
    for (const match of matches) {
      const raw = await Bun.file(`${rulesDir}/${match}`)
        .text()
        .catch((err: unknown) => {
          log?.warn("project rules: rule file unreadable", {
            path: `${RULES_DIR}/${match}`,
            error: String(err),
          });
          return "";
        });
      const entry = toEntry(`${RULES_DIR}/${match}`, raw);
      if (entry) entries.push(entry);
    }
  }

  log?.info("project rules loaded", {
    projectPath,
    total: entries.length,
    scoped: entries.filter((e) => e.paths).length,
  });
  return entries;
};

const renderEntries = (entries: readonly ProjectRulesEntry[]) =>
  entries.map((e) => `--- ${e.path} ---\n${e.content}`).join("\n\n");

/**
 * The always-on block: every rule without a path scope. Null when there
 * is nothing to inject.
 */
export const formatRulesForPrompt = (entries: readonly ProjectRulesEntry[]) => {
  const alwaysOn = entries.filter((e) => !e.paths);
  if (alwaysOn.length === 0) return null;
  return `<project_rules>\n${renderEntries(alwaysOn)}\n</project_rules>`;
};

/**
 * gitignore-style scope match, mirroring how Claude Code applies `paths:`
 * — and how the rules engine applies `exclude_globs`. A pattern with no
 * slash is a basename pattern and matches at any depth; a pattern with a
 * slash is anchored to the project-relative path.
 */
const matchesScope = (pattern: string, relativeFilePath: string) => {
  const glob = new Glob(pattern);
  if (glob.match(relativeFilePath)) return true;
  return !pattern.includes("/") && glob.match(basename(relativeFilePath));
};

/**
 * Path-scoped rules whose globs match a project-relative file path. A
 * leading `./` on the file path is tolerated.
 */
export const scopedRulesFor = (
  entries: readonly ProjectRulesEntry[],
  relativeFilePath: string,
) => {
  const target = relativeFilePath.replace(/^\.\//, "");
  return entries.filter((e) =>
    e.paths?.some((pattern) => matchesScope(pattern, target)),
  );
};

/**
 * Block for the rules that apply to one file, rendered when that file
 * is read. Null when no scoped rule matches.
 */
export const formatScopedRules = (
  entries: readonly ProjectRulesEntry[],
  relativeFilePath: string,
) => {
  const matched = scopedRulesFor(entries, relativeFilePath);
  if (matched.length === 0) return null;
  return `<project_rules scope="${relativeFilePath}">\n${renderEntries(matched)}\n</project_rules>`;
};
