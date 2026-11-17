import { describe, expect, test } from "bun:test";
import type { EmbedQuery } from "../brain/retrieve";
import type { Logger } from "../logger";
import type { LocalFileInfo, LocalFileInfoOpts } from "./file-context";
import {
  countMemories,
  fileContextSummary,
  lookupFileInfo,
  renderFileContext,
} from "./file-context-render";

const FILE = "src/app.ts";
const ROOT = "/repo/project";
const PROJECT_ID = "project-uuid";

const FULL_INFO = {
  contentHash: "abc123",
  symbols: [
    { kind: "function", name: "main", line: 3 },
    { kind: "const", name: "PORT", line: 1 },
  ],
  imports: [
    { target: "src/util.ts", specifier: "./util" },
    { target: "node:path", specifier: "node:path" },
    { target: "src/bare.ts", specifier: "" },
  ],
  dependents: [
    { source: "src/index.ts", specifier: "./app" },
    { source: "test/app.test.ts", specifier: "../src/app" },
  ],
  memories: "- memory one\n  nested detail\n- memory two",
  memoryCount: 2,
};

const FULL_BLOCK = `<file_context path="${FILE}">
<symbols>
- function main (line 3)
- const PORT (line 1)
</symbols>

<imports>
- ./util → src/util.ts
- node:path
- src/bare.ts
</imports>

<dependents>
- src/index.ts
- test/app.test.ts
</dependents>

<memories>
- memory one
  nested detail
- memory two
</memories>
</file_context>`;

describe("renderFileContext", () => {
  test("renders every section in order, byte for byte", () => {
    expect(renderFileContext(FILE, FULL_INFO)).toBe(FULL_BLOCK);
  });

  test("omits empty sections and joins the rest with a blank line", () => {
    const block = renderFileContext(FILE, {
      symbols: [],
      imports: [{ target: "src/util.ts", specifier: "./util" }],
      dependents: [],
      memories: "- only memory",
    });
    expect(block).toBe(
      `<file_context path="${FILE}">\n<imports>\n- ./util → src/util.ts\n</imports>\n\n<memories>\n- only memory\n</memories>\n</file_context>`,
    );
  });

  test("omits absent sections", () => {
    expect(
      renderFileContext(FILE, {
        dependents: [{ source: "src/index.ts", specifier: "./app" }],
      }),
    ).toBe(
      `<file_context path="${FILE}">\n<dependents>\n- src/index.ts\n</dependents>\n</file_context>`,
    );
  });

  test("returns an empty string when every section is empty", () => {
    expect(renderFileContext(FILE, {})).toBe("");
    expect(
      renderFileContext(FILE, {
        contentHash: "abc123",
        symbols: [],
        imports: [],
        dependents: [],
        memories: null,
        memoryCount: 0,
      }),
    ).toBe("");
    expect(renderFileContext(FILE, { memories: "" })).toBe("");
  });
});

describe("countMemories", () => {
  test("prefers memoryCount when it is a number", () => {
    expect(countMemories({ memoryCount: 7, memories: "- a\n- b" })).toBe(7);
  });

  test("a memoryCount of 0 wins over non-empty memories", () => {
    expect(countMemories({ memoryCount: 0, memories: "- a\n- b" })).toBe(0);
  });

  test("falls back to counting top-level bullets", () => {
    expect(
      countMemories({ memories: "- a\n  - nested\n  more\n- b\n- c" }),
    ).toBe(3);
  });

  test("is 0 for missing, null or empty memories", () => {
    expect(countMemories({})).toBe(0);
    expect(countMemories({ memories: null })).toBe(0);
    expect(countMemories({ memories: "" })).toBe(0);
  });
});

describe("fileContextSummary", () => {
  test("reports dependents and memories", () => {
    expect(fileContextSummary(FULL_INFO)).toBe(
      "↻ File context: 2 dependents, 2 memories",
    );
  });

  test("counts memories by bullet and dependents as 0 when absent", () => {
    expect(fileContextSummary({ memories: "- a\n- b\n- c" })).toBe(
      "↻ File context: 0 dependents, 3 memories",
    );
  });
});

const LOCAL_INFO: LocalFileInfo = {
  contentHash: "abc123",
  symbols: [{ kind: "function", name: "main", line: 3 }],
  imports: [],
  dependents: [],
  memories: null,
  memoryCount: 0,
};

/** A logger that records every call by level. */
const recordingLog = () => {
  const calls: { level: string; message: string; context: unknown }[] = [];
  const record = (level: string) => (message: string, context?: unknown) => {
    calls.push({ level, message, context });
  };
  const log: Logger = {
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  };
  return { log, calls };
};

const fakeEmbed: EmbedQuery = async () => [0.1, 0.2];

describe("lookupFileInfo", () => {
  test("passes the lookup and the embedder through and resolves the info", async () => {
    const { log, calls } = recordingLog();
    const received: LocalFileInfoOpts[] = [];
    let embedderBuilds = 0;
    const info = await lookupFileInfo(
      { rootPath: ROOT, filePath: FILE, projectId: PROJECT_ID, log },
      {
        buildLocalFileInfo: async (opts) => {
          received.push(opts);
          return LOCAL_INFO;
        },
        createEmbedQuery: () => {
          embedderBuilds += 1;
          return fakeEmbed;
        },
      },
    );
    expect(info).toEqual(LOCAL_INFO);
    expect(embedderBuilds).toBe(1);
    expect(received).toEqual([
      {
        rootPath: ROOT,
        filePath: FILE,
        projectId: PROJECT_ID,
        embedQuery: fakeEmbed,
      },
    ]);
    expect(calls.filter((c) => c.level === "warn")).toEqual([]);
  });

  test("passes a null projectId through", async () => {
    const { log } = recordingLog();
    const received: LocalFileInfoOpts[] = [];
    await lookupFileInfo(
      { rootPath: ROOT, filePath: FILE, projectId: null, log },
      {
        buildLocalFileInfo: async (opts) => {
          received.push(opts);
          return LOCAL_INFO;
        },
        createEmbedQuery: () => fakeEmbed,
      },
    );
    expect(received[0]?.projectId).toBeNull();
  });

  test("resolves null and warns once with the path and error when the lookup rejects", async () => {
    const { log, calls } = recordingLog();
    const info = await lookupFileInfo(
      { rootPath: ROOT, filePath: FILE, projectId: PROJECT_ID, log },
      {
        buildLocalFileInfo: async () => {
          throw new Error("cart index locked");
        },
        createEmbedQuery: () => fakeEmbed,
      },
    );
    expect(info).toBeNull();
    const warnings = calls.filter((c) => c.level === "warn");
    expect(warnings).toHaveLength(1);
    expect(JSON.stringify(warnings[0])).toContain(FILE);
    expect(JSON.stringify(warnings[0])).toContain("cart index locked");
    expect(calls.filter((c) => c.level === "error")).toEqual([]);
  });
});
