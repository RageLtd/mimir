/**
 * Mechanical detector for the "Dependency Management" rule (CRITICAL).
 * Paired with dependencies.md. Flags direct edits to dependency sections
 * of manifest files, steering the agent back to the language's package
 * manager CLI (`bun add`, `cargo add`, `go get`, `uv add`).
 *
 * Detection is two-layered:
 *   1. filePath matches a known manifest file
 *   2. content contains a dependency-section key or a version-looking value
 *
 * The second layer cuts false positives on unrelated manifest edits (e.g.
 * changing a `"scripts"` entry in package.json is fine — only dep sections
 * are gated). For TOML files this is trickier because [dependencies] and
 * version specs can appear far apart; we flag any edit that touches a
 * version-looking string inside a .toml/.json manifest as a reasonable
 * approximation.
 */

interface DetectInput {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly filePath?: string;
  readonly content?: string;
}

const MANIFEST_PATTERNS: Array<{ re: RegExp; kind: string }> = [
  { re: /(^|\/)package\.json$/, kind: "package.json" },
  { re: /(^|\/)Cargo\.toml$/, kind: "Cargo.toml" },
  { re: /(^|\/)go\.mod$/, kind: "go.mod" },
  { re: /(^|\/)pyproject\.toml$/, kind: "pyproject.toml" },
];

const manifestKind = (filePath: string) => {
  for (const { re, kind } of MANIFEST_PATTERNS) {
    if (re.test(filePath)) return kind;
  }
  return null;
};

// Per-manifest patterns that strongly indicate a dependency-section touch.
// Each regex runs against the CONTENT of the edit (new_string for Edit,
// full content for Write). A single hit is enough to flag.
const DEP_SIGNALS: Record<string, RegExp[]> = {
  "package.json": [
    /"(?:dependencies|devDependencies|peerDependencies|optionalDependencies)"\s*:/,
    /"[^"]+"\s*:\s*"(?:\^|~|>=|<=|=|>|<)?\d/,
  ],
  "Cargo.toml": [
    /\[(?:dependencies|dev-dependencies|build-dependencies|workspace\.dependencies)\]/,
    /^\s*[\w-]+\s*=\s*"[\d.~^*<>=]/m,
  ],
  "go.mod": [/^\s*require\s+/m, /^\s*[\w./-]+\s+v\d+\.\d+/m],
  "pyproject.toml": [
    /\[(?:tool\.poetry\.dependencies|project\.dependencies|tool\.uv\.sources)\]/,
    /^\s*[\w-]+\s*=\s*["'\d]/m,
    /^\s*"[\w-]+[><=~]/m,
  ],
};

const detect = (input: DetectInput) => {
  if (!input.filePath) return [];
  const kind = manifestKind(input.filePath);
  if (!kind) return [];
  if (!input.content) return [];

  const signals = DEP_SIGNALS[kind] ?? [];
  for (const re of signals) {
    const match = re.exec(input.content);
    if (match) {
      // Derive an approximate line number from match index for better nudge UX.
      const lineNum = input.content.slice(0, match.index).split("\n").length;
      return [
        {
          message: `Direct edit to ${kind} dependency section — use the package manager CLI instead (see paired rule).`,
          line: lineNum,
          snippet: match[0].slice(0, 80).trim(),
        },
      ];
    }
  }
  return [];
};

export default detect;
