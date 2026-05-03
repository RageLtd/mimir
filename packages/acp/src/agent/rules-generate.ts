/**
 * Helpers for the `/rules generate` slash command.
 *
 * Discovery + synthetic-prompt construction live here so commands.ts
 * stays close to its existing per-command-handler size budget. The
 * actual orchestration (call discovery, build prompt, dispatch via
 * `core.prompt`) is the only thing that remains in commands.ts.
 */
import { Glob } from "bun";
import * as path from "node:path";

/**
 * Discover rule body markdowns under `<rulesDir>` that lack a sibling
 * `.enforce.toml`. Pairing is by basename: `coding/x.md` pairs with
 * `coding/x.enforce.toml`. Files without a pair are returned as
 * absolute paths in lexicographic order.
 *
 * Plugin-symlinked rule bodies (e.g. via the `claude-rules` plugin's
 * SessionStart sync) land in `.claude/rules/` as regular file entries,
 * so this discovery works for both vendored and plugin-shipped bodies.
 */
export const findOrphanedRuleBodies = async (rulesDir: string) => {
  const glob = new Glob("**/*.md");
  const orphaned: string[] = [];
  for await (const rel of glob.scan({ cwd: rulesDir, dot: true })) {
    const baseName = rel.slice(0, -".md".length);
    const enforcePath = path.join(rulesDir, `${baseName}.enforce.toml`);
    const exists = await Bun.file(enforcePath).exists();
    if (!exists) {
      orphaned.push(path.join(rulesDir, rel));
    }
  }
  return orphaned.sort();
};

/**
 * Build the synthetic prompt the model executes for `/rules generate`.
 * Inlines the `.enforce.toml` schema, field vocabulary, and built-in
 * detector list so the model has everything it needs without searching.
 * The list of orphaned rule bodies is appended as bullet points; the
 * model reads each, decides whether the rule is mechanical (regex-able)
 * or conceptual (skip), and writes `.enforce.toml` files where warranted.
 */
export const buildRulesGeneratePrompt = (orphanedPaths: readonly string[]) => {
  const ruleList = orphanedPaths.map((p) => `- ${p}`).join("\n");
  return `Generate \`.enforce.toml\` files for project rules that don't have one.

## Schema

Each rule lives in a \`.enforce.toml\` colocated with its \`.md\` body:

\`\`\`toml
id = "<unique-id>"        # required, unique across all rules; convention: <category>/<name>
body = "./<name>.md"      # path to the rule body, relative to this .toml
enabled = true            # optional, default true
event = "<event>"         # required: bash | file | stop | prompt | all
exclude_globs = [...]     # optional: glob patterns suppressing the rule per-call
message = "..."           # optional template; \${1}..\${9} (regex captures), \${match}, \${line}
detector = "builtin:<name>"   # optional; bypasses conditions, dispatches to a built-in
detector_args = { ... }       # optional; built-in-specific args

[[conditions]]            # AND-joined; required when no detector
field = "<field>"
operator = "regex_match"  # regex_match | contains | equals
pattern = "..."

[[negative_conditions]]   # AND-NOT-joined; suppresses the rule when ANY match
field = "..."
operator = "..."
pattern = "..."
\`\`\`

## Field vocabulary

For \`event = "file"\` (Edit / Write / MultiEdit):
- \`file_path\` — absolute path of the file being edited
- \`new_text\` — incoming content (Edit's \`new_string\`, Write's \`content\`, MultiEdit's joined edits)
- \`old_text\` — Edit's \`old_string\` when present

For \`event = "bash"\`:
- \`command\` — the Bash command string

Any top-level \`tool_input\` key is also resolvable for any event.

## Built-in detectors

- \`builtin:file-length\` — args: \`{ limit = <number> }\`. Reads the on-disk file, simulates the edit, flags when the post-edit line count exceeds \`limit\`. Use this when the rule is about file size rather than content patterns.

## Your task

For each rule body listed below:

1. Read the rule markdown.
2. Decide whether it describes a **mechanical** pattern detectable by regex or a builtin (e.g. "no \`console.log\`", "no try/catch", "use the package manager CLI for dependency edits") OR a **conceptual** guideline that requires reasoning to apply (e.g. "use functional programming paradigms", "name things clearly", "favor composition over inheritance"). **Skip the conceptual ones — they belong in CLAUDE.md context, not in the enforcement engine.**
3. For mechanical rules, write a \`.enforce.toml\` file next to the \`.md\` (same directory, same basename, \`.enforce.toml\` extension).
4. Use \`id = "<category>/<name>"\` matching the file's location under \`.claude/rules/\` (e.g. \`coding/no-any\` for \`.claude/rules/coding/no-any.md\`).
5. Use the smallest matcher that captures the pattern. Lean on \`exclude_globs\` for path negation (\`*.test.*\`, \`*.d.ts\`) and \`negative_conditions\` for content-level "unless" clauses.
6. Default to \`event = "file"\` for code rules; \`event = "bash"\` for command rules.

When you finish, summarise what you generated (rule id + one-line reason) and what you skipped (rule id + the conceptual concern that made it unfit).

## Rule bodies without enforcement

${ruleList}
`;
};
