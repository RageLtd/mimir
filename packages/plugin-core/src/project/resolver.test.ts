import { describe, expect, test } from "bun:test";

import { normalizeGitRemote, resolveProjectForPath } from "./resolver";

describe("normalizeGitRemote", () => {
  test("canonicalizes common transports to the same repository identity", () => {
    expect(normalizeGitRemote("git@github.com:RageLtd/mimir.git")).toBe(
      "github.com/RageLtd/mimir",
    );
    expect(normalizeGitRemote("ssh://git@github.com/RageLtd/mimir.git")).toBe(
      "github.com/RageLtd/mimir",
    );
    expect(normalizeGitRemote("https://github.com/RageLtd/mimir/ ")).toBe(
      "github.com/RageLtd/mimir",
    );
  });
});

describe("resolveProjectForPath", () => {
  test("derives the same id across machines and transports", async () => {
    const ssh = await resolveProjectForPath(
      "https://server.invalid",
      "tenant-secret",
      "/Users/one/mimir",
      "git@github.com:RageLtd/mimir.git",
    );
    const https = await resolveProjectForPath(
      "https://different.invalid",
      undefined,
      "/home/two/src/mimir",
      "https://github.com/RageLtd/mimir",
    );

    expect(ssh.id).toMatch(/^project:[0-9a-f]{24}$/);
    expect(https.id).toBe(ssh.id);
    expect(ssh.git_remote).toBe("github.com/RageLtd/mimir");
  });

  test("uses an absolute local path when no remote exists", async () => {
    const first = await resolveProjectForPath("", undefined, "./local", null);
    const second = await resolveProjectForPath("", undefined, "./local", null);

    expect(first.id).toBe(second.id);
    expect(first.local_path).toStartWith("/");
    expect(first.title).toBe("local");
  });
});
