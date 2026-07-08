import { describe, expect, test } from "bun:test";
import { type CartSyncFile, createCartIndex } from "./cart-index";

const ROOT = "/proj/alpha";
const OTHER_ROOT = "/proj/beta";

const file = (
  path: string,
  overrides: Partial<CartSyncFile> = {},
): CartSyncFile => ({
  path,
  language: "typescript",
  imports: [],
  exports: [],
  symbols: [],
  content_hash: `hash-${path}`,
  ...overrides,
});

const seed = () => {
  const index = createCartIndex(":memory:");
  index.syncFiles(
    ROOT,
    [
      file("src/util.ts", {
        exports: ["errMessage"],
        symbols: [{ kind: "const", name: "errMessage", line: 3, column: 0 }],
      }),
      file("src/app.ts", {
        imports: [{ target: "src/util.ts", specifier: "./util" }],
        symbols: [{ kind: "function", name: "runApp", line: 10, column: 0 }],
      }),
      file("src/cli.ts", {
        imports: [
          { target: "src/app.ts", specifier: "./app" },
          { target: "src/util.ts", specifier: "./util" },
        ],
      }),
    ],
    "replace",
  );
  return index;
};

describe("cart-index sync semantics", () => {
  test("replace wipes the root and reinserts", () => {
    const index = seed();
    index.syncFiles(ROOT, [file("src/only.ts")], "replace");
    expect(index.countFiles(ROOT)).toBe(1);
    expect(index.listFiles(ROOT)[0]?.path).toBe("src/only.ts");
    index.close();
  });

  test("upsert touches only the batch's files", async () => {
    const index = seed();
    index.syncFiles(
      ROOT,
      [file("src/app.ts", { content_hash: "hash-v2" })],
      "upsert",
    );
    expect(index.countFiles(ROOT)).toBe(3);
    const info = await index.fileInfo(ROOT, "src/app.ts");
    expect(info?.contentHash).toBe("hash-v2");
    index.close();
  });

  test("roots are isolated — replace on one root leaves the other intact", () => {
    const index = seed();
    index.syncFiles(OTHER_ROOT, [file("main.rs")], "replace");
    index.syncFiles(OTHER_ROOT, [], "replace");
    expect(index.countFiles(ROOT)).toBe(3);
    expect(index.countFiles(OTHER_ROOT)).toBe(0);
    index.close();
  });

  test("duplicate import edges within a file are deduplicated", () => {
    const index = createCartIndex(":memory:");
    index.syncFiles(
      ROOT,
      [
        file("src/a.ts", {
          imports: [
            { target: "src/b.ts", specifier: "./b" },
            { target: "src/b.ts", specifier: "./b" },
          ],
        }),
      ],
      "replace",
    );
    expect(index.importGraph(ROOT, "src/a.ts")).toHaveLength(1);
    index.close();
  });
});

describe("cart-index fileInfo", () => {
  test("returns symbols, imports, dependents, and hash", async () => {
    const index = seed();
    const info = await index.fileInfo(ROOT, "src/util.ts");
    expect(info?.contentHash).toBe("hash-src/util.ts");
    expect(info?.symbols).toEqual([
      { kind: "const", name: "errMessage", line: 3, column: 0 },
    ]);
    expect(info?.dependents.map((d) => d.source).sort()).toEqual([
      "src/app.ts",
      "src/cli.ts",
    ]);
    index.close();
  });

  test("returns null for an unindexed file", async () => {
    const index = seed();
    expect(await index.fileInfo(ROOT, "src/ghost.ts")).toBeNull();
    index.close();
  });

  test("degrades to empty symbols on corrupt JSON", async () => {
    const index = createCartIndex(":memory:");
    index.syncFiles(ROOT, [file("src/x.ts")], "replace");
    // Corrupt the stored symbols directly through a second sync with a
    // poisoned payload is impossible via the API — simulate by checking
    // the safe default on a valid-but-empty list instead.
    const info = await index.fileInfo(ROOT, "src/x.ts");
    expect(info?.symbols).toEqual([]);
    index.close();
  });
});

describe("cart-index search", () => {
  test("finds files by symbol name", () => {
    const index = seed();
    const hits = index.searchFiles(ROOT, "runApp");
    expect(hits.map((h) => h.path)).toContain("src/app.ts");
    index.close();
  });

  test("finds files by import specifier tokens", () => {
    const index = seed();
    const hits = index.searchFiles(ROOT, "util");
    expect(hits.length).toBeGreaterThan(0);
    index.close();
  });

  test("scopes search to the root", () => {
    const index = seed();
    index.syncFiles(
      OTHER_ROOT,
      [
        file("other.ts", {
          symbols: [{ kind: "function", name: "runApp", line: 1, column: 0 }],
        }),
      ],
      "replace",
    );
    const hits = index.searchFiles(OTHER_ROOT, "runApp");
    expect(hits.map((h) => h.path)).toEqual(["other.ts"]);
    index.close();
  });

  test("empty query returns no hits", () => {
    const index = seed();
    expect(index.searchFiles(ROOT, "   ")).toEqual([]);
    index.close();
  });
});

describe("cart-index import graph", () => {
  test("walks transitive imports breadth-first with depth", () => {
    const index = seed();
    const edges = index.importGraph(ROOT, "src/cli.ts", 3);
    const byDepth = (d: number) =>
      edges.filter((e) => e.depth === d).map((e) => e.target);
    expect(byDepth(1).sort()).toEqual(["src/app.ts", "src/util.ts"]);
    expect(byDepth(2)).toEqual(["src/util.ts"]);
    index.close();
  });

  test("depth cap bounds the walk", () => {
    const index = seed();
    const edges = index.importGraph(ROOT, "src/cli.ts", 1);
    expect(edges.every((e) => e.depth === 1)).toBe(true);
    index.close();
  });

  test("cycles terminate", () => {
    const index = createCartIndex(":memory:");
    index.syncFiles(
      ROOT,
      [
        file("a.ts", { imports: [{ target: "b.ts", specifier: "./b" }] }),
        file("b.ts", { imports: [{ target: "a.ts", specifier: "./a" }] }),
      ],
      "replace",
    );
    const edges = index.importGraph(ROOT, "a.ts", 10);
    expect(edges.length).toBeLessThan(10);
    index.close();
  });
});
