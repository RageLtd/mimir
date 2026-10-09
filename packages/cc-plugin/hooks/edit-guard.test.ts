import { expect, test } from "claude-code/testing";
import { BASH_RESULT, binary, runsOf, session } from "./support.test-helpers";

test("denies a single-file shell edit, naming the file and the Edit tool", async ($, on) => {
  session(on);
  binary(on);
  const ran: string[] = [];
  on("tool.call", { tool: "Bash" }, (_, e) => {
    ran.push(e.command);
    return { result: BASH_RESULT };
  });

  const result = await $.tool.call({
    tool: "Bash",
    command: "sed -i 's/a/b/' src/app.ts",
  });

  expect(ran).toEqual([]);
  expect(result.deny).toContain("src/app.ts");
  expect(result.deny).toContain("Edit tool");
});

test("denies a bulk shell edit", async ($, on) => {
  session(on);
  binary(on);
  on("tool.call", { tool: "Bash" }, () => ({ result: BASH_RESULT }));

  const result = await $.tool.call({
    tool: "Bash",
    command: "sed -i 's/a/b/g' src/*.ts",
  });

  expect(result.deny).toContain("many paths");
});

test("lets a read-only command through to the tool", async ($, on) => {
  session(on);
  const runs = binary(on);
  on("tool.call", { tool: "Bash" }, () => ({ result: BASH_RESULT }));

  const result = await $.tool.call({ tool: "Bash", command: "git status" });

  expect(result.deny).toBeUndefined();
  expect(result.result).toEqual(BASH_RESULT);
  // The guard itself never runs the binary.
  expect(runsOf(runs, "edit-guard")).toEqual([]);
});

test("MIMIR_EDIT_GUARD=0 turns it off for the session", async ($, on) => {
  session(on, { MIMIR_EDIT_GUARD: "0" });
  binary(on);
  on("tool.call", { tool: "Bash" }, () => ({ result: BASH_RESULT }));

  const result = await $.tool.call({
    tool: "Bash",
    command: "sed -i 's/a/b/' src/app.ts",
  });

  expect(result.deny).toBeUndefined();
});
