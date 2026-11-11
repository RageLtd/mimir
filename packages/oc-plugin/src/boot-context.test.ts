/**
 * OpenCode's boot block on a session's first request carries the active
 * project's newest summary — where the last session left off — whether or
 * not it is near the first prompt. Later prompts' retrieval does not.
 *
 * MIMIR_HOME and MIMIR_ORG_REPLICA_DB point at a temp dir per test; the
 * project id is pre-cached there so nothing resolves over the network, and
 * MIMIR_EMBEDDER_PORT points at a closed port with no embedder installed,
 * so no query vector exists and nothing is near the prompt.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveProjectRoot,
  setCachedProjectId,
} from "@mimir/plugin-core/project";
import { createOrgReplica } from "@mimir/plugin-core/store/org-replica";
import { assembleBootContext, retrieveTurnContext } from "./boot-context";

const ENV_KEYS = [
  "MIMIR_HOME",
  "MIMIR_ORG_REPLICA_DB",
  "MIMIR_EMBEDDER_PORT",
] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

const PROJECT_ID = "project:a";
const NEWEST_OURS = "where our last session left off";
const OLDER_OURS = "our older summary";
const THEIRS = "another project's newer summary";

let tmp = "";
let projectPath = "";

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "mimir-oc-boot-"));
  process.env.MIMIR_HOME = join(tmp, "home");
  process.env.MIMIR_ORG_REPLICA_DB = join(tmp, "replica.sqlite");
  // Nothing listens on the discard port; with no embedder installed under
  // the temp MIMIR_HOME, the query embedder gives no vector.
  process.env.MIMIR_EMBEDDER_PORT = "9";
  projectPath = join(tmp, "repo");
  await mkdir(projectPath, { recursive: true });
  await setCachedProjectId(await resolveProjectRoot(projectPath), PROJECT_ID);

  const replica = createOrgReplica(join(tmp, "replica.sqlite"));
  replica.upsertMemory({
    id: "summary:ours-old",
    content: OLDER_OURS,
    created_at: "2026-10-01 09:00:00",
    project_id: PROJECT_ID,
    type: "summary",
  });
  replica.upsertMemory({
    id: "summary:ours-new",
    content: NEWEST_OURS,
    created_at: "2026-10-18 09:00:00",
    project_id: PROJECT_ID,
    type: "summary",
  });
  replica.upsertMemory({
    id: "summary:theirs",
    content: THEIRS,
    created_at: "2026-10-20 09:00:00",
    project_id: "project:b",
    type: "summary",
  });
  replica.close();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(tmp, { recursive: true, force: true });
});

const opts = (promptText: string) => ({
  promptText,
  projectPath,
  config: {
    serverUrl: "http://unused.invalid",
    apiKey: "key",
    userMemoryDb: ":memory:",
  },
});

describe("assembleBootContext", () => {
  test("a session's first prompt gets the active project's newest summary, not another project's", async () => {
    const boot = await assembleBootContext(opts("unrelated first prompt"));

    expect(boot).toContain(`<active_project id="${PROJECT_ID}" />`);
    expect(boot).toContain(NEWEST_OURS);
    expect(boot).not.toContain(THEIRS);
    expect(boot).not.toContain(OLDER_OURS);
  });
});

describe("retrieveTurnContext", () => {
  test("a later prompt does not get the newest summary when it is not near", async () => {
    const block = await retrieveTurnContext(opts("unrelated later prompt"));

    expect(block ?? "").not.toContain(NEWEST_OURS);
  });
});
