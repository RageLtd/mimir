---
paths: ["**/package.json", "**/Cargo.toml", "**/go.mod", "**/pyproject.toml"]
tools: ["Edit", "Write", "MultiEdit"]
---
# Dependency Management (CRITICAL)

**Do not manually edit dependency lists in manifest files.** Use the language's package manager for all dependency operations:

- **TypeScript/JavaScript**: `bun add <pkg>` / `bun remove <pkg>`
- **Rust**: `cargo add <pkg>` / `cargo remove <pkg>`
- **Go**: `go get <pkg>` / `go mod tidy`
- **Python**: `uv add <pkg>` / `uv remove <pkg>`

This means: do not use the Edit tool, Write tool, or any text editor to add, remove, or change version numbers in `package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, or similar files. Run the package manager command instead.

## Workspace Dependencies

In monorepos, if a package is used by more than one workspace member, elevate it to a workspace-level dependency.

- **Bun/npm/pnpm**: Root `package.json` with `"workspace:*"` protocol
- **Rust (Cargo)**: `[workspace.dependencies]` in root `Cargo.toml`; reference with `dep.workspace = true`
- **Python (uv)**: Root `pyproject.toml` under `[tool.uv.workspace]`

## Adding New Dependencies

Use stdlib and existing dependencies before adding new packages. New dependencies require justification. Do not add single-function packages.
