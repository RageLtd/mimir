/**
 * Project metadata collection tests.
 *
 * Uses real temp directories with manifest files to exercise the parsers.
 * Each test creates its own isolated directory, writes the files it needs,
 * and calls collectProjectMetadata against it.
 *
 * Scope is tighter than the ACP version — we cover the cross-language
 * dispatch and one representative case per manifest type rather than
 * exhaustively retesting every framework name. The curated lists are
 * verbatim from the ACP module so the ACP test suite already covers
 * the per-name matching exhaustively.
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

describe("package.json", () => {
  test("detects typescript when tsconfig.json exists", async () => {
    const dir = await mkTmp();
    await writeFile(dir, "package.json", JSON.stringify({ name: "test" }));
    await writeFile(dir, "tsconfig.json", "{}");
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toContain("typescript");
    expect(meta.technologies).not.toContain("javascript");
  });

  test("falls back to javascript when no typescript markers", async () => {
    const dir = await mkTmp();
    await writeFile(dir, "package.json", JSON.stringify({ name: "test" }));
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toContain("javascript");
  });

  test("detects bun via bun.lock", async () => {
    const dir = await mkTmp();
    await writeFile(dir, "package.json", JSON.stringify({ name: "test" }));
    await writeFile(dir, "bun.lock", "{}");
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toContain("bun");
  });

  test("pulls known framework names from dependencies", async () => {
    const dir = await mkTmp();
    await writeFile(
      dir,
      "package.json",
      JSON.stringify({
        name: "test",
        dependencies: { hono: "^4.0.0", express: "^4.0.0", random: "^1.0.0" },
      }),
    );
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toContain("hono");
    expect(meta.technologies).toContain("express");
    expect(meta.technologies).not.toContain("random");
  });

  test("uses package.json description", async () => {
    const dir = await mkTmp();
    await writeFile(
      dir,
      "package.json",
      JSON.stringify({ name: "test", description: "A handy thing." }),
    );
    const meta = await collectProjectMetadata(dir);
    expect(meta.description).toBe("A handy thing.");
  });
});

describe("Cargo.toml", () => {
  test("detects rust and known crates", async () => {
    const dir = await mkTmp();
    await writeFile(
      dir,
      "Cargo.toml",
      [
        "[package]",
        'name = "x"',
        'description = "Crate description"',
        "",
        "[dependencies]",
        'tokio = "1"',
        'serde = "1"',
        'something-random = "0.1"',
      ].join("\n"),
    );
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toContain("rust");
    expect(meta.technologies).toContain("tokio");
    expect(meta.technologies).toContain("serde");
    expect(meta.technologies).not.toContain("something-random");
    expect(meta.description).toBe("Crate description");
  });
});

describe("go.mod", () => {
  test("detects go", async () => {
    const dir = await mkTmp();
    await writeFile(dir, "go.mod", "module example.com/x\n\ngo 1.22\n");
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toContain("go");
    expect(meta.description).toBeNull();
  });
});

describe("pyproject.toml", () => {
  test("detects python and known packages", async () => {
    const dir = await mkTmp();
    await writeFile(
      dir,
      "pyproject.toml",
      [
        "[project]",
        'name = "x"',
        'description = "A Python thing"',
        'dependencies = ["fastapi>=0.110", "numpy"]',
      ].join("\n"),
    );
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toContain("python");
    expect(meta.technologies).toContain("fastapi");
    expect(meta.technologies).toContain("numpy");
    expect(meta.description).toBe("A Python thing");
  });
});

describe("no manifests", () => {
  test("returns empty metadata", async () => {
    const dir = await mkTmp();
    const meta = await collectProjectMetadata(dir);
    expect(meta.technologies).toEqual([]);
    expect(meta.description).toBeNull();
  });
});
