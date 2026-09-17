import { describe, expect, test } from "bun:test";

import { classifyBashEdit, decide, shellWords } from "./edit-guard-hook";

const shape = (cmd: string) => classifyBashEdit(cmd).shape;

describe("shellWords", () => {
  test("splits on whitespace and keeps quoted runs together", () => {
    expect(shellWords(`sed -i 's/a b/c/' "my file.ts"`)).toEqual([
      "sed",
      "-i",
      "s/a b/c/",
      "my file.ts",
    ]);
  });

  test("keeps an empty quoted word (macOS sed -i '')", () => {
    expect(shellWords(`sed -i '' 's/a/b/' f.ts`)).toEqual([
      "sed",
      "-i",
      "",
      "s/a/b/",
      "f.ts",
    ]);
  });
});

describe("single-file shell edits are denied", () => {
  test.each([
    `sed -i 's/foo/bar/' src/app.ts`,
    `sed -i '' 's/foo/bar/g' src/app.ts`,
    `sed -i.bak -E 's/foo+/bar/' src/app.ts`,
    `sed -i -e 's/foo/bar/' -e 's/x/y/' package.json`,
    `perl -pi -e 's/foo/bar/' src/app.ts`,
    `perl -i -pe 's/foo/bar/' README.md`,
    `echo "export FOO=1" >> .env.example`,
    `cat > src/new.ts <<'EOF'\nexport const x = 1;\nEOF`,
    `printf 'a\\nb\\n' > docs/list.txt`,
    `some-generator | tee config/out.yaml`,
    `python3 -c "open('src/app.ts','w').write(open('src/app.ts').read().replace('a','b'))"`,
    `python3 - <<'PY'\nfrom pathlib import Path\np = Path("src/app.ts")\np.write_text(p.read_text().replace("a", "b"))\nPY`,
    `node -e "const fs=require('fs');fs.writeFileSync('src/app.ts', fs.readFileSync('src/app.ts','utf8').replace('a','b'))"`,
  ])("%s", (cmd) => {
    const result = classifyBashEdit(cmd);
    expect(result.shape).toBe("single");
    expect(result.target).toBeTruthy();
  });

  test("names the target in the deny reason", () => {
    const decision = decide(`sed -i 's/a/b/' src/app.ts`);
    expect(decision?.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
    expect(
      "permissionDecisionReason" in (decision?.hookSpecificOutput ?? {})
        ? decision?.hookSpecificOutput.permissionDecisionReason
        : "",
    ).toContain("src/app.ts");
  });
});

describe("bulk mechanical edits are allowed with a report nudge", () => {
  test.each([
    `sed -i 's/foo/bar/g' src/a.ts src/b.ts`,
    `sed -i 's/foo/bar/g' src/*.ts`,
    `find src -name '*.ts' -exec sed -i 's/foo/bar/g' {} +`,
    `grep -rl oldName src | xargs sed -i 's/oldName/newName/g'`,
    `git ls-files '*.md' | xargs perl -pi -e 's/Foo/Bar/g'`,
    `for f in src/**/*.ts; do sed -i 's/a/b/' "$f"; done`,
    `python3 - <<'PY'\nimport glob\nfor p in glob.glob("src/**/*.ts", recursive=True):\n    s = open(p).read().replace("a", "b")\n    open(p, "w").write(s)\nPY`,
    `python3 -c "import os\nfor root, _, files in os.walk('src'):\n  open(os.path.join(root, files[0]), 'w').write('x')"`,
    `echo a > src/a.ts; echo b > src/b.ts`,
  ])("%s", (cmd) => {
    expect(shape(cmd)).toBe("bulk");
  });

  test("denies, pointing at the Edit tool and codemod tooling", () => {
    const decision = decide(`sed -i 's/foo/bar/g' src/a.ts src/b.ts`);
    expect(decision?.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
    expect(
      "permissionDecisionReason" in (decision?.hookSpecificOutput ?? {})
        ? decision?.hookSpecificOutput.permissionDecisionReason
        : "",
    ).toContain("Edit tool");
  });
});

describe("non-edits and ambiguous commands pass silently", () => {
  test.each([
    // Fan-out over read-only commands is not an edit.
    `for d in a b; do echo "== $d: $(git -C $d status --short)"; done`,
    `find . -name '*.ts' -exec cat {} \\;`,
    `git ls-files | xargs wc -l`,
    `grep -rl foo src/ | xargs grep -n bar`,
    `for f in src/**/*.ts; do bun test "$f"; done`,
    `sed -n '1,20p' src/app.ts`,
    `sed 's/foo/bar/' src/app.ts`,
    `cat src/app.ts`,
    `grep -rn "foo" src/`,
    `bun test 2>&1`,
    `bun run build > /tmp/mimir-build.log 2>&1`,
    `git diff > /dev/null`,
    `awk '$3 > 100 { print $1 }' data.csv`,
    `python3 -c "print(1 > 0)"`,
    `python3 -c "import json; print(json.load(open('package.json'))['name'])"`,
    `python3 scripts/migrate.py`,
    `node -e "console.log(require('./package.json').version)"`,
    `ls -la && git status`,
    `sed -i 's/a/b/' "$FILE"`,
    `cat > "$OUT" <<'EOF'\nx\nEOF`,
    `echo done`,
    ``,
  ])("%s", (cmd) => {
    expect(shape(cmd)).toBe("none");
    expect(decide(cmd)).toBeNull();
  });

  test("a sed expression mentioning find is not a fan-out", () => {
    expect(shape(`sed -i 's/find this/that/' src/app.ts`)).toBe("single");
  });

  test("malformed shell does not throw", () => {
    expect(() =>
      classifyBashEdit(`echo "unterminated > src/x.ts`),
    ).not.toThrow();
    expect(() => classifyBashEdit(`<<EOF\n\n`)).not.toThrow();
  });
});
