import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserMemoryStore } from "../store/user-memories";
import { assembleBootContext } from "./boot-context";

// A server nothing listens on: project-id resolution fails fast and the
// block carries no <project_context>, which is the degraded path anyway.
const DEAD_SERVER = "http://127.0.0.1:9";

let home: string;
const saved = {
  MIMIR_HOME: process.env.MIMIR_HOME,
  MIMIR_ORG_REPLICA_DB: process.env.MIMIR_ORG_REPLICA_DB,
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "mimir-boot-"));
  process.env.MIMIR_HOME = home;
  process.env.MIMIR_ORG_REPLICA_DB = join(home, "org-replica.db");
  await Bun.write(
    join(home, "config.json"),
    JSON.stringify({
      serverUrl: DEAD_SERVER,
      userMemoryDb: join(home, "user-memories.db"),
    }),
  );
  const store = createUserMemoryStore(join(home, "user-memories.db"));
  store.addProfileEntry("name: Rage");
  store.close();
});

afterEach(async () => {
  process.env.MIMIR_HOME = saved.MIMIR_HOME;
  process.env.MIMIR_ORG_REPLICA_DB = saved.MIMIR_ORG_REPLICA_DB;
  await rm(home, { recursive: true, force: true });
});

describe("assembleBootContext", () => {
  test("with a prompt, carries both the profile and the session-context section", async () => {
    const block = await assembleBootContext({
      promptText: "where were we?",
      projectPath: home,
    });
    expect(block).toContain("<user_profile_section>");
    expect(block).toContain("Rage");
    expect(block).toContain("<session_context_section>");
    expect(block).toContain("No prior session context");
  });

  test("without a prompt, leaves the session-context section out entirely", async () => {
    const block = await assembleBootContext({ projectPath: home });
    expect(block).toContain("<user_profile_section>");
    expect(block).toContain("Rage");
    expect(block).not.toContain("session_context_section");
    expect(block).toEndWith("</user_profile_section>\n</boot_context>");
  });

  test("returns null when no config is installed", async () => {
    await rm(join(home, "config.json"));
    expect(await assembleBootContext({ projectPath: home })).toBeNull();
  });
});
