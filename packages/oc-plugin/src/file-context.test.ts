import { describe, expect, test } from "bun:test";
import {
  createFileContextCache,
  type FileInfoResponse,
  renderFileContext,
} from "./file-context";

describe("renderFileContext", () => {
  test("renders symbols, imports, dependents and memories into one block", () => {
    const info: FileInfoResponse = {
      contentHash: "abc",
      symbols: [{ kind: "const", name: "foo", line: 3 }],
      imports: [{ specifier: "./bar", target: "src/bar.ts" }],
      dependents: [{ source: "src/baz.ts", specifier: "./foo" }],
      memories: "- a memory",
    };
    const block = renderFileContext("src/foo.ts", info);
    expect(block).toBe(
      '<file_context path="src/foo.ts">\n' +
        "<symbols>\n- const foo (line 3)\n</symbols>\n\n" +
        "<imports>\n- ./bar → src/bar.ts\n</imports>\n\n" +
        "<dependents>\n- src/baz.ts\n</dependents>\n\n" +
        "<memories>\n- a memory\n</memories>\n" +
        "</file_context>",
    );
  });

  test("omits empty sections", () => {
    const info: FileInfoResponse = {
      contentHash: "abc",
      symbols: [{ kind: "fn", name: "x", line: 1 }],
    };
    const block = renderFileContext("x.ts", info);
    expect(block).toContain("<symbols>");
    expect(block).not.toContain("<imports>");
    expect(block).not.toContain("<dependents>");
    expect(block).not.toContain("<memories>");
  });

  test("returns empty string when there is nothing to render", () => {
    const info: FileInfoResponse = { contentHash: "abc" };
    expect(renderFileContext("x.ts", info)).toBe("");
  });
});

describe("createFileContextCache", () => {
  test("content-hash keyed hit/miss/invalidate", () => {
    const cache = createFileContextCache();
    expect(cache.get("f.ts")).toBeUndefined();

    cache.set("f.ts", { hash: "h1", block: "<block1/>" });
    expect(cache.get("f.ts")?.hash).toBe("h1");

    // A new content hash for the same file supersedes the old entry —
    // this is what lets a re-read after an edit re-render.
    cache.set("f.ts", { hash: "h2", block: "<block2/>" });
    expect(cache.get("f.ts")?.block).toBe("<block2/>");
  });
});
