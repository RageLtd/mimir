/**
 * Project metadata collection.
 *
 * Reads manifest files (package.json, Cargo.toml, go.mod, pyproject.toml)
 * from a project directory and extracts technologies and description.
 * Technologies are a curated set of recognizable names — not every
 * dependency, just the ones that meaningfully describe the project's stack.
 *
 * Ported from packages/acp/src/project/metadata.ts. Differences: uses the
 * plugin's file-based createLogger instead of pino's createChildLogger;
 * otherwise verbatim, since the manifest-parsing logic is shared across
 * both clients.
 *
 * Returns collected metadata suitable for PATCHing to the project entity.
 * Never throws — malformed or missing files yield empty results.
 */

import { createLoggerFactory } from "../logger";

const log =
  createLoggerFactory("mimir-plugin").createLogger("project-metadata");

export type ProjectMetadata = {
  readonly technologies: readonly string[];
  readonly description: string | null;
};

const EMPTY: ProjectMetadata = { technologies: [], description: null };

// ── Curated framework lists ────────────────────────────────────────────
// Only names that meaningfully describe a project's stack. Matched against
// dependency keys (package.json) or crate/module names.

const JS_FRAMEWORKS = new Set([
  "react",
  "next",
  "vue",
  "nuxt",
  "svelte",
  "solid-js",
  "angular",
  "express",
  "hono",
  "fastify",
  "koa",
  "nest",
  "remix",
  "astro",
  "tailwindcss",
  "electron",
  "tauri",
  "bun",
]);

const RUST_CRATES = new Set([
  "tokio",
  "actix-web",
  "axum",
  "serde",
  "warp",
  "rocket",
  "tonic",
  "sqlx",
  "diesel",
  "tauri",
  "ratatui",
  "bevy",
  "clap",
]);

const PYTHON_PACKAGES = new Set([
  "django",
  "flask",
  "fastapi",
  "starlette",
  "celery",
  "sqlalchemy",
  "pytorch",
  "torch",
  "tensorflow",
  "numpy",
  "pandas",
  "scikit-learn",
]);

// ── File helpers ───────────────────────────────────────────────────────

const fileExists = (path: string) => Bun.file(path).exists();

const readJson = async (path: string) => {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return file.json().catch((err) => {
    log.debug("failed to parse manifest", { path, error: String(err) });
    return null;
  });
};

const readText = async (path: string) => {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return file.text().catch((err) => {
    log.debug("failed to read manifest", { path, error: String(err) });
    return null;
  });
};

// ── Manifest parsers ───────────────────────────────────────────────────

type ManifestResult = { technologies: string[]; description: string | null };

const matchKeys = (
  deps: Record<string, unknown> | undefined | null,
  known: Set<string>,
) => {
  if (!deps || typeof deps !== "object") return [];
  return Object.keys(deps).filter((k) => known.has(k));
};

const collectFromPackageJson = async (projectPath: string) => {
  const pkg = await readJson(`${projectPath}/package.json`);
  if (!pkg || typeof pkg !== "object") return null;

  const technologies: string[] = [];
  const description =
    typeof pkg.description === "string" && pkg.description.trim()
      ? pkg.description.trim()
      : null;

  // Detect TypeScript vs JavaScript
  const hasTsConfig = await fileExists(`${projectPath}/tsconfig.json`);
  const hasTsDep =
    typeof pkg.devDependencies === "object" &&
    pkg.devDependencies !== null &&
    "typescript" in pkg.devDependencies;
  technologies.push(hasTsConfig || hasTsDep ? "typescript" : "javascript");

  // Detect Bun vs Node
  const hasBunTypes =
    typeof pkg.devDependencies === "object" &&
    pkg.devDependencies !== null &&
    "bun-types" in pkg.devDependencies;
  const hasBunLock = await fileExists(`${projectPath}/bun.lock`);
  const hasBunLockb = await fileExists(`${projectPath}/bun.lockb`);
  if (hasBunTypes || hasBunLock || hasBunLockb) {
    technologies.push("bun");
  }

  // Key frameworks from dependencies + devDependencies
  const allDeps = {
    ...((pkg.dependencies as Record<string, unknown>) ?? {}),
    ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
  };
  technologies.push(...matchKeys(allDeps, JS_FRAMEWORKS));

  return { technologies, description };
};

const collectFromCargoToml = async (projectPath: string) => {
  const text = await readText(`${projectPath}/Cargo.toml`);
  if (!text) return null;

  const technologies: string[] = ["rust"];
  let description: string | null = null;

  // Extract description from [package] section — simple line scan,
  // no full TOML parser needed for a single field.
  const descMatch = text.match(/^\s*description\s*=\s*"([^"]*)"/m);
  if (descMatch?.[1]?.trim()) {
    description = descMatch[1].trim();
  }

  // Extract dependency names from [dependencies] and [dev-dependencies]
  const depSection = text.match(/\[dependencies\]\s*\n([\s\S]*?)(?=\n\[|\n*$)/);
  const devDepSection = text.match(
    /\[dev-dependencies\]\s*\n([\s\S]*?)(?=\n\[|\n*$)/,
  );
  const depLines = [
    ...(depSection?.[1]?.split("\n") ?? []),
    ...(devDepSection?.[1]?.split("\n") ?? []),
  ];
  for (const line of depLines) {
    const name = line.match(/^(\S+)\s*=/)?.[1];
    if (name && RUST_CRATES.has(name)) {
      technologies.push(name);
    }
  }

  return { technologies, description };
};

const collectFromGoMod = async (projectPath: string) => {
  const text = await readText(`${projectPath}/go.mod`);
  if (!text) return null;
  return { technologies: ["go"] as string[], description: null };
};

const collectFromPyproject = async (projectPath: string) => {
  const text = await readText(`${projectPath}/pyproject.toml`);
  if (!text) return null;

  const technologies: string[] = ["python"];
  let description: string | null = null;

  const descMatch = text.match(/^\s*description\s*=\s*"([^"]*)"/m);
  if (descMatch?.[1]?.trim()) {
    description = descMatch[1].trim();
  }

  // Scan dependency lines for known packages
  const depSection = text.match(
    /\[project\.dependencies\]\s*\n([\s\S]*?)(?=\n\[|\n*$)/,
  );
  // Also check the flat dependencies array: dependencies = ["flask>=2.0", ...]
  const depArray = text.match(/^\s*dependencies\s*=\s*\[([\s\S]*?)\]/m);
  const depText = (depSection?.[1] ?? "") + (depArray?.[1] ?? "");
  for (const pkg of PYTHON_PACKAGES) {
    if (depText.includes(pkg)) {
      technologies.push(pkg);
    }
  }

  return { technologies, description };
};

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Collect project metadata from manifest files in `projectPath`.
 *
 * Reads package.json, Cargo.toml, go.mod, and pyproject.toml in parallel.
 * Technologies are merged across all detected manifests (a monorepo might
 * have both package.json and Cargo.toml). Description uses the first
 * non-null value found, in order: package.json → Cargo.toml → pyproject.toml.
 *
 * Never throws — all filesystem and parse errors are logged at debug
 * level and result in empty contributions.
 */
export const collectProjectMetadata = async (projectPath: string) => {
  const settled = await Promise.all([
    collectFromPackageJson(projectPath).catch(() => null),
    collectFromCargoToml(projectPath).catch(() => null),
    collectFromGoMod(projectPath).catch(() => null),
    collectFromPyproject(projectPath).catch(() => null),
  ]);

  const results: ManifestResult[] = [];
  for (const r of settled) {
    if (r) results.push(r);
  }
  if (results.length === 0) return EMPTY;

  const technologies = [...new Set(results.flatMap((r) => r.technologies))];
  const description =
    results.find((r) => r.description !== null)?.description ?? null;

  log.info("collected metadata", {
    projectPath,
    technologyCount: technologies.length,
    hasDescription: description !== null,
  });

  return { technologies, description };
};
