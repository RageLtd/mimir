/**
 * A moved test file is not a deleted one: the gate pairs the old path
 * with the new one, through `collectChanges` on a real git repository,
 * and the checks judge the pair as an edit.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectChanges } from "./changes";
import { sanityCheck, testCounts } from "./checks";
import { runCommand } from "./exec";

const OLD_PATH = "src/widget/format.test.ts";
const NEW_PATH = "src/format/format.test.ts";
const DELETED = "test file deleted";
const ORIGINAL_TESTS = 12;

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const git = async (cwd: string, ...args: string[]) => {
  const r = await runCommand(["git", ...args], cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const write = async (root: string, rel: string, content: string) => {
  await mkdir(dirname(join(root, rel)), { recursive: true });
  await Bun.write(join(root, rel), content);
};

/** One realistic test: a setup line, a call, two assertions. */
const testCase = (i: number, assertions = 2) => {
  const lines = [
    `  test("formats case ${i}", () => {`,
    `    const input = { id: ${i}, label: "item-${i}", tags: ["a", "b"] };`,
    `    const out = format(input);`,
    `    expect(out.id).toBe(${i});`,
    `    expect(out.label).toBe("ITEM-${i}");`,
    "  });",
    "",
  ];
  return assertions >= 2
    ? lines.join("\n")
    : lines.filter((l) => !l.includes("out.label")).join("\n");
};

const testFile = (
  count: number,
  { comment = "// Formatting rules.", weakened = 0 } = {},
) =>
  [
    'import { describe, expect, test } from "bun:test";',
    'import { format } from "./format";',
    "",
    comment,
    'describe("format", () => {',
    ...Array.from({ length: count }, (_, i) =>
      testCase(i + 1, i < weakened ? 1 : 2),
    ),
    "});",
    "",
  ].join("\n");

/** A different suite: other names, other bodies, three assertions each. */
const rewrittenFile = (count: number) =>
  [
    'import { describe, expect, test } from "bun:test";',
    'import { format, parse } from "./format";',
    "",
    'describe("format round-trip", () => {',
    ...Array.from({ length: count }, (_, i) =>
      [
        `  test("round-trips record ${i + 1} with nested fields", () => {`,
        `    const record = { key: "k${i + 1}", nested: { depth: ${i + 1}, flags: [true, false] } };`,
        "    const text = format(record);",
        "    const back = parse(text);",
        `    expect(typeof text).toBe("string");`,
        `    expect(back.key).toBe("k${i + 1}");`,
        `    expect(back.nested.depth).toBe(${i + 1});`,
        "  });",
        "",
      ].join("\n"),
    ),
    "});",
    "",
  ].join("\n");

/** A repo whose base commit holds a source file and a 12-test file at OLD_PATH. */
const seedRepo = async (tests = ORIGINAL_TESTS) => {
  const root = await mkdtemp(join(tmpdir(), "mimir-rename-"));
  dirs.push(root);
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.email", "t@example.com");
  await git(root, "config", "user.name", "t");
  await write(
    root,
    "src/widget/format.ts",
    "export const format = (x: unknown) => x;\n",
  );
  await write(root, OLD_PATH, testFile(tests));
  await git(root, "add", ".");
  await git(root, "commit", "-q", "-m", "base");
  return root;
};

const gateOn = async (root: string) => {
  const changes = await collectChanges(runCommand, root);
  if (!changes) throw new Error("collectChanges returned null");
  return {
    sanity: sanityCheck(changes.files),
    counts: testCounts(changes.files),
  };
};

describe("verify gate: moved test files", () => {
  test("staged git mv, content unchanged → no sanity problem, counts N → N", async () => {
    const root = await seedRepo();
    await mkdir(join(root, dirname(NEW_PATH)), { recursive: true });
    await git(root, "mv", OLD_PATH, NEW_PATH);

    const { sanity, counts } = await gateOn(root);
    expect(sanity?.reason ?? "").not.toContain(DELETED);
    expect(sanity).toBeNull();
    expect(counts).toEqual({ before: ORIGINAL_TESTS, after: ORIGINAL_TESTS });
  });

  test("staged git mv with four tests added and a comment edited → not a deletion", async () => {
    const root = await seedRepo();
    await mkdir(join(root, dirname(NEW_PATH)), { recursive: true });
    await git(root, "mv", OLD_PATH, NEW_PATH);
    await write(
      root,
      NEW_PATH,
      testFile(ORIGINAL_TESTS + 4, { comment: "// Formatting rules, moved." }),
    );
    await git(root, "add", NEW_PATH);

    const { sanity, counts } = await gateOn(root);
    expect(sanity?.reason ?? "").not.toContain(DELETED);
    expect(sanity).toBeNull();
    expect(counts).toEqual({
      before: ORIGINAL_TESTS,
      after: ORIGINAL_TESTS + 4,
    });
  });

  test("a move that drops assertions is still blocked as assertions removed", async () => {
    const root = await seedRepo();
    await mkdir(join(root, dirname(NEW_PATH)), { recursive: true });
    await git(root, "mv", OLD_PATH, NEW_PATH);
    await write(root, NEW_PATH, testFile(ORIGINAL_TESTS, { weakened: 3 }));
    await git(root, "add", NEW_PATH);

    const { sanity } = await gateOn(root);
    expect(sanity?.reason).toContain("assertions removed");
    expect(sanity?.reason).not.toContain(DELETED);
  });

  test("a test file deleted outright is still reported as deleted", async () => {
    const root = await seedRepo();
    await git(root, "rm", "-q", OLD_PATH);

    const { sanity, counts } = await gateOn(root);
    expect(sanity?.reason).toContain(`${OLD_PATH}: ${DELETED}`);
    expect(counts).toEqual({ before: ORIGINAL_TESTS, after: 0 });
  });

  test("unstaged move with identical content → treated like a staged move", async () => {
    const root = await seedRepo();
    const content = await Bun.file(join(root, OLD_PATH)).text();
    await write(root, NEW_PATH, content);
    await rm(join(root, OLD_PATH));

    const { sanity, counts } = await gateOn(root);
    expect(sanity?.reason ?? "").not.toContain(DELETED);
    expect(sanity).toBeNull();
    expect(counts).toEqual({ before: ORIGINAL_TESTS, after: ORIGINAL_TESTS });
  });

  test("move against an older task base, file rewritten in between → not a deletion, counts from the base", async () => {
    const root = await seedRepo(4);
    const taskBase = await git(root, "rev-parse", "HEAD");
    await write(root, OLD_PATH, rewrittenFile(12));
    await git(root, "commit", "-q", "-am", "rewrite tests");
    await mkdir(join(root, dirname(NEW_PATH)), { recursive: true });
    await git(root, "mv", OLD_PATH, NEW_PATH);
    await write(root, NEW_PATH, rewrittenFile(16));
    await git(root, "add", NEW_PATH);

    const changes = await collectChanges(runCommand, root, taskBase);
    if (!changes) throw new Error("collectChanges returned null");
    expect(sanityCheck(changes.files)?.reason ?? "").not.toContain(DELETED);
    expect(testCounts(changes.files)).toEqual({ before: 4, after: 16 });
  });
});

/** Not a test path under the TS convention: no `.test`/`.spec`, no `tests/` dir. */
const FIXTURE_PATH = "src/widget/format.fixture.ts";
const OTHER_PATH = "src/other/format.test.ts";

describe("verify gate: moves the pairing must not accept", () => {
  test("staged git mv to a non-test path → still a deleted test", async () => {
    const root = await seedRepo();
    await git(root, "mv", OLD_PATH, FIXTURE_PATH);

    const { sanity } = await gateOn(root);
    expect(sanity?.reason).toContain(`${OLD_PATH}: ${DELETED}`);
  });

  test("unstaged move to a non-test path → still a deleted test", async () => {
    const root = await seedRepo();
    const content = await Bun.file(join(root, OLD_PATH)).text();
    await write(root, FIXTURE_PATH, content);
    await rm(join(root, OLD_PATH));

    const { sanity } = await gateOn(root);
    expect(sanity?.reason).toContain(`${OLD_PATH}: ${DELETED}`);
  });

  test("one deleted test file, two untracked identical copies → paired once, counts N → 2N", async () => {
    const root = await seedRepo();
    const content = await Bun.file(join(root, OLD_PATH)).text();
    await write(root, NEW_PATH, content);
    await write(root, OTHER_PATH, content);
    await rm(join(root, OLD_PATH));

    const { sanity, counts } = await gateOn(root);
    expect(sanity?.reason ?? "").not.toContain(DELETED);
    expect(counts).toEqual({
      before: ORIGINAL_TESTS,
      after: ORIGINAL_TESTS * 2,
    });
  });

  test("unstaged move with content edited → reported as deleted, with a hint to stage the move", async () => {
    const root = await seedRepo();
    await write(root, NEW_PATH, testFile(ORIGINAL_TESTS + 4));
    await rm(join(root, OLD_PATH));

    const { sanity } = await gateOn(root);
    expect(sanity?.reason).toContain(`${OLD_PATH}: ${DELETED}`);
    expect(sanity?.reason).toMatch(/git (add|mv)/);
  });
});
