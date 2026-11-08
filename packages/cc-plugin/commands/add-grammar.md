---

description: Add a tree-sitter grammar to Cartographer's host grammar library so Mimir can index another language — builds the grammar, writes its queries and manifest, validates it, and re-indexes the current project
argument-hint: "<language> [grammar-repo-url]"
allowed-tools: ["Bash", "Read", "Write", "Edit", "AskUserQuestion", "WebFetch"]
---

You are adding a tree-sitter grammar to Cartographer's host grammar library. Cartographer compiles six languages into its binary (TypeScript/TSX, JavaScript, Rust, Ruby, Elixir) and loads any others at startup from `~/.cartographer/grammars/<name>/`. A grammar directory holds a shared library built by the tree-sitter CLI, a `language.json` manifest, and two queries: `tags.scm` (symbols) and `imports.scm` (import edges).

Mimir's hooks spawn a fresh cartographer for every re-index, so a new grammar takes effect the moment you run a full re-index — no session restart.

Two rules that are not negotiable:

- **Everything is built and installed under the grammars directory, never inside the project you are working in.** Cartographer refuses to load libraries from anywhere else, by design: loading a shared library runs arbitrary code.
- **The grammar source is code that will run inside cartographer.** Only build from a repository the user trusts. The `tree-sitter` and `tree-sitter-grammars` GitHub organisations are the norm; anything else, confirm with the user before cloning.

Carry out the steps in order.

## Step 1 — resolve arguments

`$ARGUMENTS` is `<language> [grammar-repo-url]`.

- `<language>` is the grammar's name as tree-sitter spells it: lowercase, dashes allowed (`python`, `go`, `c-sharp`). Bind it to `<lang>`.
- The repo URL defaults to `https://github.com/tree-sitter/tree-sitter-<lang>`. Bind it to `<url>`.

If `<language>` is missing, call `AskUserQuestion` for it. If `<url>` is not under `github.com/tree-sitter/` or `github.com/tree-sitter-grammars/`, call `AskUserQuestion` to confirm the user trusts that source before continuing.

## Step 2 — preflight

```bash
command -v tree-sitter && tree-sitter --version
command -v cc
command -v git
CARTO="$HOME/.mimir/bin/cartographer"; test -x "$CARTO" || CARTO="$HOME/.cartographer/bin/cartographer"
test -x "$CARTO" && echo "cartographer: $CARTO" && "$CARTO" grammars
GRAMMARS="${CARTOGRAPHER_HOME:-$HOME/.cartographer}/grammars"; echo "grammars dir: $GRAMMARS"
```

- No `tree-sitter`: stop and tell the user to install the tree-sitter CLI (`brew install tree-sitter`, `cargo install tree-sitter-cli`, or `npm i -g tree-sitter-cli`). Any CLI from 0.20 up produces a library cartographer accepts (grammar ABI 13–15); the current CLI emits ABI 15. Do not install it for them.
- No `cc`: stop; a C compiler is required to build the grammar.
- No cartographer binary: stop and tell the user to run `/mimir-install` first.
- If `<lang>` already appears in the `grammars` listing as `builtin`, stop: it is supported already. A host grammar _can_ override a builtin's extensions (later registration wins), but only do that if the user explicitly asks for it.

Keep `$CARTO` and `$GRAMMARS` for later steps.

## Step 3 — fetch the grammar into a scratch directory

```bash
WORK="$(mktemp -d)" && git clone --depth 1 "<url>" "$WORK/grammar" && ls "$WORK/grammar"
```

Read `$WORK/grammar/tree-sitter.json`. Its `grammars` array has one entry per grammar in the repo, each with:

- `name` — the grammar name; the exported symbol is `tree_sitter_<name with dashes as underscores>`
- `path` — the grammar's directory relative to the repo root (`.` for single-grammar repos; `typescript` / `tsx` in multi-grammar repos)
- `file-types` — extensions without the dot
- `tags` — the tags query file(s): a string or an array of paths relative to the repo root

If there is more than one entry, call `AskUserQuestion` to pick which to install (each becomes its own grammar directory; repeat Steps 4–7 per entry). Bind the chosen entry's values to `<name>`, `<path>`, `<file-types>`, `<tags-paths>`.

If `$WORK/grammar/<path>/src/parser.c` does not exist, the repo does not ship generated sources: run `tree-sitter generate` inside `$WORK/grammar/<path>` (this needs `node`). If that fails, stop and show the error.

## Step 4 — build the shared library

```bash
mkdir -p "$GRAMMARS/<name>"
tree-sitter build -o "$GRAMMARS/<name>/<name>.so" "$WORK/grammar/<path>"
ls -la "$GRAMMARS/<name>"
```

The directory name **must** equal `<name>` — cartographer derives the library file name and the `tree_sitter_<name>` symbol from it. If the user wants a different directory name, set `name`, `library` and `symbol` explicitly in the manifest in Step 7.

## Step 5 — symbols: tags.scm

For each path in `<tags-paths>` that exists in the clone, append its contents to `$GRAMMARS/<name>/tags.scm` (in order; multi-grammar repos often list a second file under `node_modules/`, which will be absent after a bare clone — skip missing paths and say so). Then read the result.

The query follows tree-sitter's code-navigation convention and cartographer reads it as-is: `@definition.function|method|class|interface|module|type|enum|struct|trait|macro|constant` on the defining node (anything else becomes `unknown`), `@name` on its identifier, optional `@doc` on preceding comments (`#strip!` and `#select-adjacent!` are honoured). `@reference.*` patterns are ignored.

Cartographer adds one optional capture, `@visibility`: put it on the node that marks a definition public (a `pub`, `export`, or `public` keyword node). Definitions without it are private; a query with no `@visibility` capture at all gets the manifest's `default_visibility`. Add it when the language has such a keyword and the shipped query lacks it.

If no tags query exists, write one from the convention using node names from `$WORK/grammar/<path>/src/node-types.json`.

## Step 6 — imports: imports.scm

Cartographer has its own convention here: `@import.specifier` on the node holding the module path or file path (quotes are stripped for you), and `@import.symbol` on each imported name (optional). One statement that yields several matches — one per symbol — is merged into a single edge; you do not need quantifiers.

Do not guess node names. Write a sample file covering the language's import forms, then print its tree from inside the grammar directory, where the CLI uses that grammar:

```bash
cat > "$WORK/sample.<ext>" <<'EOF'
<two or three realistic import statements, plus one function and one class/struct definition>
EOF
cd "$WORK/grammar/<path>" && tree-sitter parse "$WORK/sample.<ext>"
```

Read the printed tree for the import node kinds and their field names, then write `$GRAMMARS/<name>/imports.scm`. Worked example for Python:

```scheme
(import_statement name: (dotted_name) @import.specifier)
(import_statement name: (aliased_import name: (dotted_name) @import.specifier))
(import_from_statement
  module_name: (dotted_name) @import.specifier
  name: (dotted_name) @import.symbol)
```

## Step 7 — manifest: language.json

Write `$GRAMMARS/<name>/language.json`. Only `extensions` is required.

```json
{
  "extensions": [".py"],
  "default_visibility": "public",
  "resolvers": [
    {
      "module-path": {
        "separator": ".",
        "extensions": [".py"],
        "index_names": ["__init__"],
        "root_marker": "pyproject.toml",
        "source_dirs": ["", "src"]
      }
    }
  ]
}
```

- `extensions`: `<file-types>`, each with a leading dot.
- `resolvers`: tried in order, choose by how the language spells imports.
  - `relative-path` — `./foo`-style paths relative to the importing file: `{ "extensions": [...], "index_names": ["index"] }`.
  - `module-path` — dotted or `::`-separated module paths walked from a project root: `separator`, `extensions`, optional `root_marker` (a file that marks the root, e.g. `go.mod`, `pyproject.toml`; without it every ancestor directory is tried), `source_dirs` (`""` means the root itself), `index_names` (`__init__`, `mod`), `strip_prefixes` (`crate::`).
  - Languages with both forms list both. Unresolvable specifiers (standard library, packages) are skipped, which is intended.
- `default_visibility`: `"public"` for languages where everything top-level is reachable (Python, Go-style exports aside), `"private"` (the default) when `tags.scm` carries `@visibility`.
- Optional: `name`, `library`, `symbol`, `tags`, `imports` to override the defaults derived from the directory name.

## Step 8 — validate

```bash
"$CARTO" grammars
"$CARTO" parse "$WORK/sample.<ext>"
```

`grammars` must list `<name>` as `host` with its extensions and exit 0; on failure it prints the directory and the reason (an ABI mismatch means rebuild with a newer CLI; a missing symbol means the directory name and grammar `name` disagree — set `symbol`). `parse` must print JSON with the symbols and imports your sample contains. Empty `symbols` or `imports` means a query matched nothing: compare the capture against the tree from Step 6 and fix it. Iterate until both commands are right; show the user the final `parse` output.

## Step 9 — re-index the current project

This is the "restart": the SessionStart worker spawns a fresh cartographer, which loads the new grammar, parses every git-tracked file, and replaces the project's local index.

```bash
"$HOME/.local/bin/mimir-cc" session-start --worker "$(pwd)"
grep 'session-start reindex complete' "$HOME/.mimir/logs/mimir-cc.log" | tail -n 1
```

The worker logs rather than prints; the `grep` shows the completion line with the parsed-file count. Other projects pick the grammar up on their own next session start or edit.

## Step 10 — clean up and report

```bash
rm -rf "$WORK"
```

Tell the user: the grammar name, its directory, the extensions it now owns, and that removing it is `rm -rf "$GRAMMARS/<name>"` followed by the same re-index. If any step was skipped or any path was missing, say so plainly.
