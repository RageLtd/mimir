/**
 * Manifest-derived verify commands — the last resort of toolchain
 * resolution, consulted only when neither an explicit `[verify]` config
 * nor a task runner names the commands.
 *
 * Each matcher looks at one ecosystem's manifest and returns the
 * conventional `test` / `check` / `typecheck` invocations. A package
 * root with several manifests (a Tauri app, say) gets them joined with
 * `&&` so every ecosystem present is exercised.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { asRecord } from "../toml";
import type { VerifyCommands } from "./toolchain-types";

/** Manifest filenames that mark a package root. */
export const MANIFEST_FILES: ReadonlySet<string> = new Set([
  "package.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "build.gradle",
  "build.gradle.kts",
  "pom.xml",
  "mix.exs",
  "Package.swift",
  "Gemfile",
]);

/** Manifest suffixes (project-named files) that mark a package root. */
const MANIFEST_SUFFIXES = [".csproj", ".fsproj", ".sln"];

const listDir = (dir: string) =>
  readdir(dir).then(
    (names) => new Set(names),
    () => new Set<string>(),
  );

const readText = (filePath: string) =>
  Bun.file(filePath)
    .text()
    .then(
      (text) => text,
      () => null,
    );

const exists = (filePath: string) => Bun.file(filePath).exists();

const matchesSuffix = (name: string) =>
  MANIFEST_SUFFIXES.some((suffix) => name.endsWith(suffix));

export const hasManifest = async (dir: string) => {
  const names = await listDir(dir);
  for (const name of names) {
    if (MANIFEST_FILES.has(name) || matchesSuffix(name)) return true;
  }
  return false;
};

// ── Per-ecosystem matchers ──

const cargo = (names: ReadonlySet<string>) =>
  names.has("Cargo.toml")
    ? {
        test: "cargo test",
        check: "cargo fmt --check && cargo clippy --all-targets -- -D warnings",
        typecheck: "cargo check --all-targets",
      }
    : null;

const go = (names: ReadonlySet<string>) =>
  names.has("go.mod")
    ? {
        test: "go test ./...",
        check: "go vet ./...",
        typecheck: "go build ./...",
      }
    : null;

const python = async (root: string, names: ReadonlySet<string>) => {
  if (!names.has("pyproject.toml") && !names.has("setup.py")) return null;
  const pyproject = names.has("pyproject.toml")
    ? ((await readText(join(root, "pyproject.toml"))) ?? "")
    : "";
  const runner = names.has("uv.lock")
    ? "uv run "
    : names.has("poetry.lock")
      ? "poetry run "
      : "";
  const commands: { -readonly [K in keyof VerifyCommands]: string } = {
    test: `${runner}pytest`,
  };
  if (/\[tool\.ruff\b/.test(pyproject))
    commands.check = `${runner}ruff check .`;
  if (/\[tool\.mypy\b/.test(pyproject)) commands.typecheck = `${runner}mypy .`;
  else if (/\[tool\.pyright\b/.test(pyproject)) {
    commands.typecheck = `${runner}pyright`;
  }
  return commands;
};

type PackageManager = "bun" | "pnpm" | "yarn" | "npm";

const detectPackageManager = async (root: string, projectRoot: string) => {
  const roots = root === projectRoot ? [root] : [root, projectRoot];
  for (const dir of roots) {
    if (
      (await exists(join(dir, "bun.lock"))) ||
      (await exists(join(dir, "bun.lockb")))
    ) {
      return "bun" satisfies PackageManager;
    }
    if (await exists(join(dir, "pnpm-lock.yaml"))) return "pnpm";
    if (await exists(join(dir, "yarn.lock"))) return "yarn";
    if (await exists(join(dir, "package-lock.json"))) return "npm";
  }
  return "npm";
};

const execPrefix = (pm: PackageManager) => {
  switch (pm) {
    case "bun":
      return "bunx";
    case "pnpm":
      return "pnpm exec";
    case "yarn":
      return "yarn";
    case "npm":
      return "npx";
    default:
      return assertNever(pm);
  }
};

const assertNever = (value: never) => {
  throw new Error(`Unhandled package manager: ${String(value)}`);
};

const readPackageJson = (root: string) =>
  Bun.file(join(root, "package.json"))
    .json()
    .then(asRecord, () => null);

const devDependencies = (pkg: Record<string, unknown>) => {
  const merged: Record<string, unknown> = {};
  for (const key of ["dependencies", "devDependencies"]) {
    const deps = pkg[key];
    if (typeof deps === "object" && deps !== null) Object.assign(merged, deps);
  }
  return merged;
};

const javascript = async (
  root: string,
  names: ReadonlySet<string>,
  projectRoot: string,
) => {
  if (!names.has("package.json")) return null;
  const pkg = await readPackageJson(root);
  if (!pkg) return null;
  const pm = await detectPackageManager(root, projectRoot);
  const exec = execPrefix(pm);
  const deps = devDependencies(pkg);
  const commands: { -readonly [K in keyof VerifyCommands]: string } = {};

  if ("vitest" in deps) commands.test = `${exec} vitest run`;
  else if ("jest" in deps) commands.test = `${exec} jest`;
  else if ("mocha" in deps) commands.test = `${exec} mocha`;
  else if (pm === "bun") commands.test = "bun test";

  if (names.has("tsconfig.json")) commands.typecheck = `${exec} tsc --noEmit`;

  if (names.has("biome.json") || names.has("biome.jsonc")) {
    commands.check = `${exec} biome check .`;
  } else if (
    [...names].some(
      (n) => n.startsWith("eslint.config.") || n.startsWith(".eslintrc"),
    )
  ) {
    commands.check = `${exec} eslint .`;
  }

  return Object.keys(commands).length > 0 ? commands : null;
};

const gradle = async (
  root: string,
  names: ReadonlySet<string>,
  projectRoot: string,
) => {
  if (!names.has("build.gradle") && !names.has("build.gradle.kts")) return null;
  const wrapper =
    (await exists(join(root, "gradlew"))) ||
    (await exists(join(projectRoot, "gradlew")));
  const g = wrapper ? "./gradlew" : "gradle";
  return { test: `${g} test`, check: `${g} check` };
};

const maven = (names: ReadonlySet<string>) =>
  names.has("pom.xml")
    ? { test: "mvn -q test", check: "mvn -q verify -DskipTests" }
    : null;

const mix = (names: ReadonlySet<string>) =>
  names.has("mix.exs")
    ? {
        test: "mix test",
        check: "mix format --check-formatted",
        typecheck: "mix compile --warnings-as-errors",
      }
    : null;

const swift = (names: ReadonlySet<string>) =>
  names.has("Package.swift")
    ? { test: "swift test", typecheck: "swift build" }
    : null;

const dotnet = (names: ReadonlySet<string>) =>
  [...names].some(matchesSuffix)
    ? {
        test: "dotnet test",
        check: "dotnet format --verify-no-changes",
        typecheck: "dotnet build",
      }
    : null;

const ruby = async (root: string, names: ReadonlySet<string>) => {
  if (!names.has("Gemfile")) return null;
  const gemfile = (await readText(join(root, "Gemfile"))) ?? "";
  const commands: { -readonly [K in keyof VerifyCommands]: string } = {
    test: /\brspec\b/.test(gemfile)
      ? "bundle exec rspec"
      : "bundle exec rake test",
  };
  if (/\brubocop\b/.test(gemfile)) commands.check = "bundle exec rubocop";
  return commands;
};

// ── Merge ──

const mergeCommands = (parts: readonly VerifyCommands[]) => {
  const merged: { -readonly [K in keyof VerifyCommands]: string } = {};
  for (const key of ["test", "check", "typecheck"] as const) {
    const values = parts.map((p) => p[key]).filter((v) => v !== undefined);
    if (values.length > 0) merged[key] = values.join(" && ");
  }
  return merged;
};

/**
 * Verify commands implied by the manifests in `root`. Null when no
 * known manifest is present or none of them implies a command.
 */
export const manifestCommands = async (root: string, projectRoot: string) => {
  const names = await listDir(root);
  const found = [
    cargo(names),
    go(names),
    await python(root, names),
    await javascript(root, names, projectRoot),
    await gradle(root, names, projectRoot),
    maven(names),
    mix(names),
    swift(names),
    dotnet(names),
    await ruby(root, names),
  ].filter((c) => c !== null);
  if (found.length === 0) return null;
  const commands = mergeCommands(found);
  return Object.keys(commands).length > 0 ? commands : null;
};
