/**
 * Project rules reader.
 *
 * Reads project convention files from known locations: CLAUDE.md,
 * .cursorrules, AGENTS.md, and .claude/rules/**\/*.md. Returns them
 * formatted for injection into the system prompt so any backend
 * (CC, server, future adapters) receives the project's rules.
 */

import { stat } from "node:fs/promises";
import { Glob } from "bun";
import { createChildLogger, log } from "../utils/log";

const logger = createChildLogger(log, "rules");

/** Check whether a path is a directory. Returns false for missing paths. */
const isDirectory = async (path: string) => {
  const result = await stat(path).then(
    (s) => ({ data: s.isDirectory(), error: null }),
    (error) => ({ data: false, error }),
  );
  if (result.error && result.error.code !== "ENOENT") {
    logger.warn(
      "unexpected error checking directory: %s — %s",
      path,
      result.error.message,
    );
  }
  return result.data;
};

/** A single rules file with its source path and content. */
type RulesEntry = {
  readonly path: string;
  readonly content: string;
};

/** Known rules file names at the project root. */
const ROOT_FILES = ["CLAUDE.md", ".cursorrules", "AGENTS.md"];

/** Directory containing structured rule files. */
const RULES_DIR = ".claude/rules";

/**
 * Read all project rules from the filesystem.
 *
 * Checks root-level convention files and recursively scans
 * .claude/rules/ for markdown files. Returns an array of
 * entries with their source paths and content, or an empty
 * array if no rules files exist.
 */
const readProjectRules = async (projectPath: string): Promise<RulesEntry[]> => {
  const entries: RulesEntry[] = [];

  // Root-level files (CLAUDE.md, .cursorrules, AGENTS.md)
  for (const name of ROOT_FILES) {
    const filePath = `${projectPath}/${name}`;
    const file = Bun.file(filePath);
    if (await file.exists()) {
      const content = await file.text();
      if (content.trim()) {
        entries.push({ path: name, content: content.trim() });
      }
    }
  }

  // .claude/rules/**/*.md
  const rulesDir = `${projectPath}/${RULES_DIR}`;
  if (await isDirectory(rulesDir)) {
    const glob = new Glob("**/*.md");
    for await (const match of glob.scan({ cwd: rulesDir })) {
      const filePath = `${rulesDir}/${match}`;
      const file = Bun.file(filePath);
      const content = await file.text();
      if (content.trim()) {
        entries.push({
          path: `${RULES_DIR}/${match}`,
          content: content.trim(),
        });
      }
    }
  } else {
    logger.debug("no .claude/rules/ directory found in: %s", projectPath);
  }

  logger.info("loaded %d rules files from: %s", entries.length, projectPath);

  return entries;
};

/**
 * Format rules entries as an XML block for system prompt injection.
 * Returns null if no rules were found.
 */
const formatRulesForPrompt = (entries: RulesEntry[]): string | null => {
  if (entries.length === 0) return null;

  const sections = entries
    .map((e) => `--- ${e.path} ---\n${e.content}`)
    .join("\n\n");

  return `<project_rules>\n${sections}\n</project_rules>`;
};

export { formatRulesForPrompt, type RulesEntry, readProjectRules };
