import { describe, expect, test } from "bun:test";
import { conventionFor, isTestFile, testSignals } from "./test-conventions";

describe("conventionFor", () => {
  test("maps extensions to languages", () => {
    expect(conventionFor("a/b.ts")?.language).toBe("typescript");
    expect(conventionFor("a/b.rs")?.language).toBe("rust");
    expect(conventionFor("a/b.go")?.language).toBe("go");
    expect(conventionFor("a/b.py")?.language).toBe("python");
    expect(conventionFor("a/B.kt")?.language).toBe("jvm");
    expect(conventionFor("a/b.exs")?.language).toBe("elixir");
    expect(conventionFor("a/b.rb")?.language).toBe("ruby");
    expect(conventionFor("a/B.cs")?.language).toBe("csharp");
  });

  test("unknown extension and no extension → null", () => {
    expect(conventionFor("a/b.zig")).toBeNull();
    expect(conventionFor("Makefile")).toBeNull();
  });
});

describe("isTestFile", () => {
  const cases: readonly [string, boolean][] = [
    ["src/foo.test.ts", true],
    ["src/foo.spec.tsx", true],
    ["src/__tests__/foo.ts", true],
    ["src/foo.ts", false],
    ["tests/integration.rs", true],
    ["src/lib.rs", false],
    ["pkg/foo_test.go", true],
    ["pkg/foo.go", false],
    ["tests/test_foo.py", true],
    ["app/foo_test.py", true],
    ["app/foo.py", false],
    ["src/test/java/FooTest.java", true],
    ["src/main/java/Foo.java", false],
    ["src/main/kotlin/FooSpec.kt", true],
    ["test/foo_test.exs", true],
    ["lib/foo.ex", false],
    ["spec/foo_spec.rb", true],
    ["test/foo_test.rb", true],
    ["lib/foo.rb", false],
    ["Foo.Tests/FooTests.cs", true],
    ["Foo/Foo.cs", false],
    ["README.md", false],
  ];
  for (const [filePath, expected] of cases) {
    test(`${filePath} → ${expected}`, () => {
      expect(isTestFile(filePath)).toBe(expected);
    });
  }
});

describe("testSignals", () => {
  test("typescript counts tests, skips, assertions", () => {
    const text = [
      'test("a", () => { expect(1).toBe(1); });',
      'it.skip("b", () => {});',
      'describe.only("c", () => {});',
      "  expect(x).toEqual(y);",
      "const y = 2;",
    ].join("\n");
    expect(testSignals("x.test.ts", text)).toEqual({
      language: "typescript",
      tests: 2,
      skips: 2,
      assertions: 2,
    });
  });

  test("rust reads inline #[test] attributes, not paths", () => {
    const text = [
      "#[cfg(test)]",
      "mod tests {",
      "    #[test]",
      "    fn adds() { assert_eq!(add(1, 2), 3); }",
      "    #[tokio::test]",
      "    async fn fetches() { assert!(true); }",
      "    #[test]",
      "    #[ignore]",
      "    fn slow() {}",
      "}",
    ].join("\n");
    expect(testSignals("src/lib.rs", text)).toEqual({
      language: "rust",
      tests: 3,
      skips: 1,
      assertions: 2,
    });
  });

  test("go", () => {
    const text = [
      "func TestAdd(t *testing.T) {",
      '    if got != want { t.Errorf("bad") }',
      "}",
      'func TestSlow(t *testing.T) { t.Skip("slow") }',
      "func helper() {}",
    ].join("\n");
    expect(testSignals("add_test.go", text)).toEqual({
      language: "go",
      tests: 2,
      skips: 1,
      assertions: 1,
    });
  });

  test("python", () => {
    const text = [
      "def test_add():",
      "    assert add(1, 2) == 3",
      "@pytest.mark.skip(reason='later')",
      "async def test_fetch():",
      "    with pytest.raises(ValueError):",
      "        pass",
      "def helper(): pass",
    ].join("\n");
    expect(testSignals("test_add.py", text)).toEqual({
      language: "python",
      tests: 2,
      skips: 1,
      assertions: 2,
    });
  });

  test("jvm", () => {
    const text = [
      "@Test",
      "void adds() { assertEquals(3, add(1, 2)); }",
      "@Disabled",
      "@ParameterizedTest",
      "void many() { assertThat(x).isEqualTo(y); }",
    ].join("\n");
    expect(testSignals("AddTest.java", text)).toEqual({
      language: "jvm",
      tests: 2,
      skips: 1,
      assertions: 2,
    });
  });

  test("elixir", () => {
    const text = [
      '  test "adds" do',
      "    assert add(1, 2) == 3",
      "  end",
      "  @tag :skip",
      '  test "slow" do',
      "    refute false",
      "  end",
    ].join("\n");
    expect(testSignals("test/add_test.exs", text)).toEqual({
      language: "elixir",
      tests: 2,
      skips: 1,
      assertions: 2,
    });
  });

  test("ruby", () => {
    const text = [
      '  it "adds" do',
      "    expect(add(1, 2)).to eq(3)",
      "  end",
      '  xit "slow" do',
      "  end",
      "  def test_legacy",
      "    assert_equal 3, add(1, 2)",
      "  end",
    ].join("\n");
    expect(testSignals("spec/add_spec.rb", text)).toEqual({
      language: "ruby",
      tests: 2,
      skips: 1,
      assertions: 2,
    });
  });

  test("csharp", () => {
    const text = [
      "[Fact]",
      "public void Adds() { Assert.Equal(3, Add(1, 2)); }",
      '[Fact(Skip = "later")]',
      "public void Slow() { result.Should().Be(3); }",
    ].join("\n");
    expect(testSignals("AddTests.cs", text)).toEqual({
      language: "csharp",
      tests: 2,
      skips: 1,
      assertions: 2,
    });
  });

  test("unknown language → null", () => {
    expect(testSignals("a.zig", 'test "x" {}')).toBeNull();
  });
});
