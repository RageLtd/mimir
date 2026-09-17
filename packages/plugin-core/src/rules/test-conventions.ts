/**
 * Test conventions per language — one table, used three ways.
 *
 *   testPath    — does this path name a test file?
 *   testMarker  — does this line declare a test case?
 *   skipMarker  — does this line skip, ignore, or focus a test?
 *   assertion   — does this line assert?
 *
 * The verify gate reads the markers off a diff (Rust tests live inline
 * under `#[cfg(test)]`, so "a test was added" can't be a path check),
 * the role guard reads `testPath` to keep `mimir-impl` out of tests,
 * and `builtin:test-file` exposes the same answer to rule authors.
 *
 * Regexes are line-oriented and carry no `g` flag on purpose — `.test`
 * on a global regex is stateful and would give alternating answers.
 */

import * as path from "node:path";

export type TestLanguage =
  | "typescript"
  | "rust"
  | "go"
  | "python"
  | "jvm"
  | "elixir"
  | "ruby"
  | "csharp";

export type TestConvention = {
  readonly language: TestLanguage;
  readonly extensions: ReadonlySet<string>;
  readonly testPath: RegExp;
  readonly testMarker: RegExp;
  readonly skipMarker: RegExp;
  readonly assertion: RegExp;
};

export const TEST_CONVENTIONS: readonly TestConvention[] = [
  {
    language: "typescript",
    extensions: new Set(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]),
    testPath:
      /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|tests?)\/)/,
    testMarker: /^\s*(?:test|it)\b\s*(?:\.\w+)*\s*\(/,
    skipMarker:
      /\b(?:test|it|describe)\.(?:skip|only|todo|failing)\b|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/,
    assertion: /\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(/,
  },
  {
    language: "rust",
    extensions: new Set(["rs"]),
    testPath: /(?:^|\/)tests\/[^/]+\.rs$|_tests?\.rs$/,
    testMarker: /^\s*#\[(?:\w+::)*test\b/,
    skipMarker: /^\s*#\[ignore\b/,
    assertion: /\bassert(?:_eq|_ne|_matches)?!\s*\(|\bshould_panic\b/,
  },
  {
    language: "go",
    extensions: new Set(["go"]),
    testPath: /_test\.go$/,
    testMarker: /^func\s+(?:Test|Benchmark|Fuzz|Example)\w*\s*\(/,
    skipMarker: /\b[tb]\.Skip(?:f|Now)?\s*\(/,
    assertion:
      /\b[tb]\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(|\b(?:assert|require)\.\w+\s*\(/,
  },
  {
    language: "python",
    extensions: new Set(["py"]),
    testPath: /(?:^|\/)(?:test_[^/]*\.py|[^/]*_test\.py)$|(?:^|\/)tests?\//,
    testMarker: /^\s*(?:async\s+)?def\s+test_\w*\s*\(/,
    skipMarker:
      /@pytest\.mark\.(?:skip|skipif|xfail)\b|@unittest\.skip\w*\b|\bpytest\.skip\s*\(/,
    assertion: /^\s*assert\b|\bself\.assert\w*\s*\(|\bpytest\.raises\s*\(/,
  },
  {
    language: "jvm",
    extensions: new Set(["java", "kt", "kts", "scala"]),
    testPath:
      /(?:^|\/)src\/test\/|Tests?\.(?:java|kt|scala)$|Spec\.(?:kt|scala)$/,
    testMarker: /^\s*@(?:Test|ParameterizedTest|RepeatedTest)\b/,
    skipMarker: /^\s*@(?:Disabled|Ignore)\b/,
    assertion:
      /\bassert\w*\s*\(|\bAssertions\.\w+\s*\(|\bshould(?:Be|Equal|Throw|Contain)\w*\b/,
  },
  {
    language: "elixir",
    extensions: new Set(["ex", "exs"]),
    testPath: /(?:^|\/)test\/.*_test\.exs$/,
    testMarker: /^\s*test\s+"/,
    skipMarker: /@(?:module)?tag\s+(?::skip\b|skip:)/,
    assertion: /^\s*(?:assert|refute)\w*\b/,
  },
  {
    language: "ruby",
    extensions: new Set(["rb"]),
    testPath: /(?:^|\/)(?:spec\/.*_spec\.rb|test\/.*_test\.rb)$/,
    testMarker: /^\s*(?:it|test|specify)\s+["']|^\s*def\s+test_\w+/,
    skipMarker:
      /^\s*(?:xit|xdescribe|xcontext)\b|\bskip\s*\(?["']|skip:\s*true|\bpending\b/,
    assertion: /\bexpect\s*\(|\bassert\w*\b|\.must_\w+|\.should\b/,
  },
  {
    language: "csharp",
    extensions: new Set(["cs"]),
    testPath: /Tests?\.cs$|(?:^|\/)[^/]*\.Tests?\//,
    testMarker: /^\s*\[(?:Fact|Theory|Test|TestMethod|TestCase)\b/,
    skipMarker: /\[(?:Fact|Theory)\([^)]*Skip\s*=|\[(?:Ignore|Explicit)\b/,
    assertion: /\bAssert\.\w+\s*\(|\.Should\(\)/,
  },
];

const toPosix = (filePath: string) => filePath.split(path.sep).join("/");

/** The convention for a file, by extension. Null for unknown languages. */
export const conventionFor = (filePath: string) => {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!ext) return null;
  return TEST_CONVENTIONS.find((c) => c.extensions.has(ext)) ?? null;
};

/** True when the path names a test file in a language we know. */
export const isTestFile = (filePath: string) => {
  return conventionFor(filePath)?.testPath.test(toPosix(filePath)) ?? false;
};

const countLines = (text: string, re: RegExp) =>
  text.split("\n").filter((line) => re.test(line)).length;

export type TestSignals = {
  readonly language: TestLanguage;
  readonly tests: number;
  readonly skips: number;
  readonly assertions: number;
};

/**
 * Count test, skip and assertion markers in a block of source text.
 * Pass a whole file to size it, or just the added lines of a diff to see
 * what a change introduced. Null when the language is unknown.
 */
export const testSignals = (filePath: string, text: string) => {
  const convention = conventionFor(filePath);
  if (!convention) return null;
  return {
    language: convention.language,
    tests: countLines(text, convention.testMarker),
    skips: countLines(text, convention.skipMarker),
    assertions: countLines(text, convention.assertion),
  } satisfies TestSignals;
};
