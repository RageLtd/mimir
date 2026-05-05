/**
 * Project metadata collection tests.
 *
 * Uses real temp directories with manifest files to exercise the parsers.
 * Each test creates its own isolated directory, writes the files it needs,
 * and calls collectProjectMetadata against it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectProjectMetadata } from "./metadata";

const dirs: string[] = [];

const mkTmp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "mimir-meta-test-"));
  dirs.push(dir);
  return dir;
};

const writeFile = (dir: string, name: string, content: string) =>
  Bun.write(join(dir, name), content);

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

// ── package.json ───────────────────────────────────────────────────────

describe("package.json", () => {
  test("detects typescript when tsconfig.json exists", async () => {
    const dir = await mkTmp();
    await writeFile(dir, "package.json", JSON.stringify({ name: "test" }));
    await writeFile(dir, "tsconfig.json", "{}");
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toContain("typescript");
    expect(meta.technologies).not.toContain("javascript");
  });

  test("detects typescript from devDependencies", async () => {
    const dir = await mkTmp();
    await writeFile(
      dir,
      "package.json",
      JSON.stringify({
        name: "test",
        devDependencies: { typescript: "^5.0.0" },
      }),
    );
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toContain("typescript");
  });

  test("detects javascript when no typescript markers", async () => {
    const dir = await mkTmp();
    await writeFile(dir, "package.json", JSON.stringify({ name: "test" }));
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toContain("javascript");
  });

  test("detects bun from bun.lock", async () => {
    const dir = await mkTmp();
    await writeFile(dir, "package.json", JSON.stringify({ name: "test" }));
    await writeFile(dir, "bun.lock", "{}");
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toContain("bun");
  });

  test("detects bun from bun-types devDependency", async () => {
    const dir = await mkTmp();
    await writeFile(
      dir,
      "package.json",
      JSON.stringify({
        name: "test",
        devDependencies: { "bun-types": "^1.0.0" },
      }),
    );
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toContain("bun");
  });

  test("detects frameworks from dependencies", async () => {
    const dir = await mkTmp();
    await writeFile(
      dir,
      "package.json",
      JSON.stringify({
        name: "test",
        dependencies: { react: "^18.0.0", hono: "^4.0.0" },
      }),
    );
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toContain("react");
    expect(meta.technologies).toContain("hono");
  });

  test("extracts description", async () => {
    const dir = await mkTmp();
    await writeFile(
      dir,
      "package.json",
      JSON.stringify({
        name: "test",
        description: "A cool project",
      }),
    );
    const meta = await collectProjectMetadata(dir);
    expect(meta.description).toBe("A cool project");
  });

  test("ignores non-curated dependencies", async () => {
    const dir = await mkTmp();
    await writeFile(
      dir,
      "package.json",
      JSON.stringify({
        name: "test",
        dependencies: { lodash: "^4.0.0", "some-random-lib": "^1.0.0" },
      }),
    );
    const meta = await collectProjectMetadata(dir);
    // Only javascript should be detected (no tsconfig, no TS devDep)
    expect(meta.technologies).toEqual(["javascript"]);
  });
});

// ── Cargo.toml ─────────────────────────────────────────────────────────

describe("Cargo.toml", () => {
  test("detects rust and curated crates", async () => {
    const dir = await mkTmp();
    await writeFile(
      dir,
      "Cargo.toml",
      `[package]
name = "my-app"
version = "0.1.0"
description = "A rust service"

[dependencies]
tokio = { version = "1", features = ["full"] }
serde = "1"
`,
    );
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toContain("rust");
    expect(meta.technologies).toContain("tokio");
    expect(meta.technologies).toContain("serde");
    expect(meta.description).toBe("A rust service");
  });

  test("handles Cargo.toml without description", async () => {
    const dir = await mkTmp();
    await writeFile(
      dir,
      "Cargo.toml",
      `[package]
name = "my-app"
version = "0.1.0"

[dependencies]
axum = "0.7"
`,
    );
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toContain("rust");
    expect(meta.technologies).toContain("axum");
    expect(meta.description).toBeNull();
  });
});

// ── go.mod ─────────────────────────────────────────────────────────────

describe("go.mod", () => {
  test("detects go", async () => {
    const dir = await mkTmp();
    await writeFile(
      dir,
      "go.mod",
      `module github.com/org/repo

go 1.22
`,
    );
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toContain("go");
  });
});

// ── pyproject.toml ─────────────────────────────────────────────────────

describe("pyproject.toml", () => {
  test("detects python and frameworks from dependencies array", async () => {
    const dir = await mkTmp();
    await writeFile(
      dir,
      "pyproject.toml",
      `[project]
name = "my-app"
description = "A python API"
dependencies = ["fastapi>=0.100", "sqlalchemy>=2.0"]
`,
    );
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toContain("python");
    expect(meta.technologies).toContain("fastapi");
    expect(meta.technologies).toContain("sqlalchemy");
    expect(meta.description).toBe("A python API");
  });
});

// ── Edge cases ─────────────────────────────────────────────────────────

describe("edge cases", () => {
  test("returns empty for directory with no manifest files", async () => {
    const dir = await mkTmp();
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toEqual([]);
    expect(meta.description).toBeNull();
  });

  test("handles malformed package.json gracefully", async () => {
    const dir = await mkTmp();
    await writeFile(dir, "package.json", "not valid json {{{");
    const meta = await collectProjectMetadata(dir);
    // Should not crash — malformed file is treated as absent
    expect(meta.technologies).toEqual([]);
  });

  test("merges technologies across multiple manifests", async () => {
    const dir = await mkTmp();
    await writeFile(
      dir,
      "package.json",
      JSON.stringify({
        name: "monorepo",
        devDependencies: { typescript: "^5.0.0" },
      }),
    );
    await writeFile(dir, "tsconfig.json", "{}");
    await writeFile(
      dir,
      "Cargo.toml",
      `[package]
name = "native-addon"

[dependencies]
serde = "1"
`,
    );
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toContain("typescript");
    expect(meta.technologies).toContain("rust");
    expect(meta.technologies).toContain("serde");
  });

  test("description uses first non-null value (package.json wins)", async () => {
    const dir = await mkTmp();
    await writeFile(
      dir,
      "package.json",
      JSON.stringify({
        name: "test",
        description: "JS description",
      }),
    );
    await writeFile(
      dir,
      "Cargo.toml",
      `[package]
name = "test"
description = "Rust description"
`,
    );
    const meta = await collectProjectMetadata(dir);
    expect(meta.description).toBe("JS description");
  });

  test("deduplicates technologies", async () => {
    const dir = await mkTmp();
    await writeFile(
      dir,
      "package.json",
      JSON.stringify({
        name: "test",
        dependencies: { tauri: "^2.0.0" },
      }),
    );
    await writeFile(
      dir,
      "Cargo.toml",
      `[package]
name = "test"

[dependencies]
tauri = "2"
`,
    );
    const meta = await collectProjectMetadata(dir);
    const tauriCount = meta.technologies.filter((t) => t === "tauri").length;
    expect(tauriCount).toBe(1);
  });
});
