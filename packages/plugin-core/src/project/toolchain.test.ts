/**
 * Toolchain resolution tests — real temp directories, one per case.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  findPackageRoot,
  resolveToolchain,
  resolveToolchainsForFiles,
} from "./toolchain";

const dirs: string[] = [];

const mkTmp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "mimir-toolchain-"));
  dirs.push(dir);
  return dir;
};

const write = async (dir: string, name: string, content = "") => {
  const filePath = join(dir, name);
  await mkdir(dirname(filePath), { recursive: true });
  await Bun.write(filePath, content);
};

// An empty MIMIR_HOME so the developer's real ~/.mimir/mimir.toml can't
// leak into these cases.
const savedHome = process.env.MIMIR_HOME;
beforeAll(async () => {
  process.env.MIMIR_HOME = await mkTmp();
});

afterAll(async () => {
  if (savedHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = savedHome;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

describe("resolution order", () => {
  test("explicit [verify] config wins over everything", async () => {
    const dir = await mkTmp();
    await write(
      dir,
      "mimir.toml",
      '[verify]\ntest = "mise run test"\ncheck = "mise run lint"\n',
    );
    await write(dir, "mise.toml", '[tasks.test]\nrun = "pytest"\n');
    await write(dir, "Cargo.toml", '[package]\nname = "x"\n');
    const r = await resolveToolchain(dir);
    expect(r?.source).toBe("config");
    expect(r?.commands).toEqual({
      test: "mise run test",
      check: "mise run lint",
    });
  });

  test("config with an empty [verify] falls through", async () => {
    const dir = await mkTmp();
    await write(dir, "mimir.toml", "[verify]\n");
    await write(dir, "go.mod", "module x\n");
    expect((await resolveToolchain(dir))?.source).toBe("manifest");
  });

  test("malformed config falls through rather than throwing", async () => {
    const dir = await mkTmp();
    await write(dir, "mimir.toml", "[verify\ntest = = =\n");
    await write(dir, "go.mod", "module x\n");
    expect((await resolveToolchain(dir))?.source).toBe("manifest");
  });

  test("nested mimir.toml overrides one key, inherits the rest from the project", async () => {
    const root = await mkTmp();
    await write(
      root,
      "mimir.toml",
      '[verify]\ntest = "root-test"\ncheck = "root-check"\n',
    );
    await write(
      root,
      "packages/api/mimir.toml",
      '[verify]\ntest = "api-test"\n',
    );
    await write(root, "packages/api/Cargo.toml", '[package]\nname = "api"\n');
    const r = await resolveToolchain(join(root, "packages/api"), root);
    expect(r?.source).toBe("config");
    expect(r?.commands).toEqual({ test: "api-test", check: "root-check" });
  });

  test("a project-level [verify] applies to packages with no file of their own", async () => {
    const root = await mkTmp();
    await write(root, "mimir.toml", '[verify]\ntest = "root-test"\n');
    await write(root, "packages/api/go.mod", "module api\n");
    const r = await resolveToolchain(join(root, "packages/api"), root);
    expect(r?.commands).toEqual({ test: "root-test" });
  });

  test("task runner wins over manifest", async () => {
    const dir = await mkTmp();
    await write(dir, "mise.toml", '[tasks.test]\nrun = "pytest"\n');
    await write(dir, "pyproject.toml", "[project]\nname = 'x'\n");
    const r = await resolveToolchain(dir);
    expect(r?.source).toBe("task-runner");
    expect(r?.detail).toBe("mise.toml");
    expect(r?.commands).toEqual({ test: "mise run test" });
  });

  test("empty directory → null (callers fail closed)", async () => {
    const dir = await mkTmp();
    expect(await resolveToolchain(dir)).toBeNull();
  });
});

describe("task runners", () => {
  test("mise tasks with lint + typecheck aliases", async () => {
    const dir = await mkTmp();
    await write(
      dir,
      "mise.toml",
      "[tasks]\ntest = 'x'\nlint = 'y'\ntypecheck = 'z'\n",
    );
    expect((await resolveToolchain(dir))?.commands).toEqual({
      test: "mise run test",
      check: "mise run lint",
      typecheck: "mise run typecheck",
    });
  });

  test("justfile recipes, including ones with parameters", async () => {
    const dir = await mkTmp();
    await write(
      dir,
      "justfile",
      "default:\n  just --list\n\ntest filter='':\n  cargo test {{filter}}\n\ncheck:\n  cargo clippy\n",
    );
    const r = await resolveToolchain(dir);
    expect(r?.detail).toBe("justfile");
    expect(r?.commands).toEqual({ test: "just test", check: "just check" });
  });

  test("Makefile targets", async () => {
    const dir = await mkTmp();
    await write(
      dir,
      "Makefile",
      ".PHONY: test lint\n\ntest:\n\tgo test ./...\n\nlint:\n\tgolangci-lint run\n",
    );
    expect((await resolveToolchain(dir))?.commands).toEqual({
      test: "make test",
      check: "make lint",
    });
  });

  test("package.json scripts with the package manager from the lockfile", async () => {
    const dir = await mkTmp();
    await write(
      dir,
      "package.json",
      JSON.stringify({ scripts: { test: "vitest", typecheck: "tsc" } }),
    );
    await write(dir, "pnpm-lock.yaml");
    const r = await resolveToolchain(dir);
    expect(r?.source).toBe("task-runner");
    expect(r?.commands).toEqual({
      test: "pnpm run test",
      typecheck: "pnpm run typecheck",
    });
  });

  test("package.json scripts without matching names fall through", async () => {
    const dir = await mkTmp();
    await write(
      dir,
      "package.json",
      JSON.stringify({
        scripts: { build: "x" },
        devDependencies: { jest: "1" },
      }),
    );
    const r = await resolveToolchain(dir);
    expect(r?.source).toBe("manifest");
    expect(r?.commands.test).toBe("npx jest");
  });
});

describe("manifests", () => {
  test("Cargo.toml", async () => {
    const dir = await mkTmp();
    await write(dir, "Cargo.toml", '[package]\nname = "x"\n');
    expect((await resolveToolchain(dir))?.commands).toEqual({
      test: "cargo test",
      check: "cargo fmt --check && cargo clippy --all-targets -- -D warnings",
      typecheck: "cargo check --all-targets",
    });
  });

  test("go.mod", async () => {
    const dir = await mkTmp();
    await write(dir, "go.mod", "module x\n");
    expect((await resolveToolchain(dir))?.commands).toEqual({
      test: "go test ./...",
      check: "go vet ./...",
      typecheck: "go build ./...",
    });
  });

  test("pyproject with uv, ruff and mypy", async () => {
    const dir = await mkTmp();
    await write(
      dir,
      "pyproject.toml",
      "[project]\nname = 'x'\n[tool.ruff]\nline-length = 100\n[tool.mypy]\nstrict = true\n",
    );
    await write(dir, "uv.lock");
    expect((await resolveToolchain(dir))?.commands).toEqual({
      test: "uv run pytest",
      check: "uv run ruff check .",
      typecheck: "uv run mypy .",
    });
  });

  test("bun project with tsconfig and biome", async () => {
    const dir = await mkTmp();
    await write(dir, "package.json", JSON.stringify({ name: "x" }));
    await write(dir, "bun.lock");
    await write(dir, "tsconfig.json", "{}");
    await write(dir, "biome.json", "{}");
    expect((await resolveToolchain(dir))?.commands).toEqual({
      test: "bun test",
      typecheck: "bunx tsc --noEmit",
      check: "bunx biome check .",
    });
  });

  test("vitest + eslint under yarn", async () => {
    const dir = await mkTmp();
    await write(
      dir,
      "package.json",
      JSON.stringify({ devDependencies: { vitest: "1" } }),
    );
    await write(dir, "yarn.lock");
    await write(dir, "eslint.config.js");
    expect((await resolveToolchain(dir))?.commands).toEqual({
      test: "yarn vitest run",
      check: "yarn eslint .",
    });
  });

  test("gradle with wrapper, maven, mix, swift, dotnet, ruby", async () => {
    const gradle = await mkTmp();
    await write(gradle, "build.gradle.kts");
    await write(gradle, "gradlew");
    expect((await resolveToolchain(gradle))?.commands).toEqual({
      test: "./gradlew test",
      check: "./gradlew check",
    });

    const maven = await mkTmp();
    await write(maven, "pom.xml");
    expect((await resolveToolchain(maven))?.commands.test).toBe("mvn -q test");

    const mix = await mkTmp();
    await write(mix, "mix.exs");
    expect((await resolveToolchain(mix))?.commands.test).toBe("mix test");

    const swift = await mkTmp();
    await write(swift, "Package.swift");
    expect((await resolveToolchain(swift))?.commands).toEqual({
      test: "swift test",
      typecheck: "swift build",
    });

    const dotnet = await mkTmp();
    await write(dotnet, "Foo.csproj");
    expect((await resolveToolchain(dotnet))?.commands.test).toBe("dotnet test");

    const ruby = await mkTmp();
    await write(ruby, "Gemfile", "gem 'rspec'\ngem 'rubocop'\n");
    expect((await resolveToolchain(ruby))?.commands).toEqual({
      test: "bundle exec rspec",
      check: "bundle exec rubocop",
    });
  });

  test("two manifests in one root are joined with &&", async () => {
    const dir = await mkTmp();
    await write(dir, "Cargo.toml", '[package]\nname = "x"\n');
    await write(dir, "package.json", JSON.stringify({ name: "x" }));
    await write(dir, "bun.lock");
    expect((await resolveToolchain(dir))?.commands.test).toBe(
      "cargo test && bun test",
    );
  });
});

describe("monorepo", () => {
  test("findPackageRoot walks up to the nearest manifest, not above the project", async () => {
    const root = await mkTmp();
    await write(root, "package.json", JSON.stringify({ name: "root" }));
    await write(root, "packages/api/Cargo.toml", '[package]\nname = "api"\n');
    await write(root, "packages/api/src/lib.rs");
    await write(root, "packages/web/src/index.ts");

    expect(await findPackageRoot("packages/api/src/lib.rs", root)).toBe(
      join(root, "packages/api"),
    );
    expect(await findPackageRoot("packages/web/src/index.ts", root)).toBe(root);
    expect(
      await findPackageRoot(join(root, "packages/api/src/lib.rs"), root),
    ).toBe(join(root, "packages/api"));
  });

  test("resolveToolchainsForFiles groups by root and sees the root lockfile", async () => {
    const root = await mkTmp();
    await write(root, "pnpm-lock.yaml");
    await write(
      root,
      "packages/a/package.json",
      JSON.stringify({ scripts: { test: "x" } }),
    );
    await write(root, "packages/b/go.mod", "module b\n");
    await write(root, "packages/c/README.md");

    const resolved = await resolveToolchainsForFiles(
      [
        "packages/a/src/one.ts",
        "packages/a/src/two.ts",
        "packages/b/main.go",
        "packages/c/notes.txt",
      ],
      root,
    );
    expect([...resolved.keys()].sort()).toEqual([
      root,
      join(root, "packages/a"),
      join(root, "packages/b"),
    ]);
    expect(resolved.get(join(root, "packages/a"))?.commands.test).toBe(
      "pnpm run test",
    );
    expect(resolved.get(join(root, "packages/b"))?.source).toBe("manifest");
    expect(resolved.get(root)).toBeNull();
  });
});
