import { expect, test } from "bun:test";
import { OPENCODE_ENVIRONMENT } from "./environment";

test("OpenCode environment names its host and in-process tools", () => {
  expect(OPENCODE_ENVIRONMENT.match(/<environment>/g)).toHaveLength(1);
  expect(OPENCODE_ENVIRONMENT).toContain("OpenCode");
  expect(OPENCODE_ENVIRONMENT).toContain("@RageLtd/mimir-oc");
  for (const name of [
    "user_memory_search",
    "user_profile_get",
    "project_memory_search",
    "project_playbook_load",
    "cartographer_search",
  ])
    expect(OPENCODE_ENVIRONMENT).toContain(name);
  expect(OPENCODE_ENVIRONMENT).not.toContain("mcp__plugin_mimir-cc");
  expect(OPENCODE_ENVIRONMENT).not.toContain(
    "You are running as a Claude Code",
  );
});
