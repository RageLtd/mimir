import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../logger";
import { setCachedProjectId } from "../project/cache";
import { createOrgReplica } from "../store/org-replica";
import { createUserMemoryStore } from "../store/user-memories";
import { assembleBootContext, buildSessionContext } from "./boot-context";

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

  test("with a prompt, the active project's newest summary arrives even when it is not near the prompt", async () => {
    // Seeds the project-id cache under the (non-git) project root, so
    // resolution never reaches the dead server.
    await setCachedProjectId(home, "project:boot");
    const replica = createOrgReplica(join(home, "org-replica.db"));
    replica.upsertMemory({
      id: "memory:last-session",
      content: "we were migrating the sync queue",
      type: "summary",
      project_id: "project:boot",
      created_at: "2026-11-09 09:00:00",
      embedding: [0, 0, 1],
    });
    replica.upsertMemory({
      id: "memory:elsewhere",
      content: "another project's work",
      type: "summary",
      project_id: "project:other",
      created_at: "2026-11-10 09:00:00",
      embedding: [0, 0, 1],
    });
    replica.close();

    const block = await assembleBootContext({
      promptText: "something unrelated entirely",
      projectPath: home,
    });
    expect(block).toContain('<active_project id="project:boot" />');
    const section = block?.match(
      /<session_context_section>[\s\S]*<\/session_context_section>/,
    )?.[0];
    expect(section).toContain("we were migrating the sync queue");
    expect(section).not.toContain("another project's work");
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

  test("a given config is used in place of the config file, which need not exist", async () => {
    await rm(join(home, "config.json"));
    const otherDb = join(home, "other-user-memories.db");
    const other = createUserMemoryStore(otherDb);
    other.addProfileEntry("name: Odin");
    other.close();

    const block = await assembleBootContext({
      projectPath: home,
      config: { serverUrl: DEAD_SERVER, userMemoryDb: otherDb },
    });
    expect(block).toStartWith("<boot_context>");
    expect(block).toContain("Odin");
    expect(block).not.toContain("Rage");
  });

  test("a given user-memory store builds the profile, stays open, and the config's db is never opened", async () => {
    const neverOpened = join(home, "never-opened.db");
    const store = createUserMemoryStore(join(home, "injected.db"));
    store.addProfileEntry("name: Odin");

    const block = await assembleBootContext({
      projectPath: home,
      config: { serverUrl: DEAD_SERVER, userMemoryDb: neverOpened },
      userMemoryStore: store,
    });
    expect(block).toContain("Odin");
    expect(block).not.toContain("Rage");
    expect(await Bun.file(neverOpened).exists()).toBe(false);
    // Still open: the call does not own the store it was handed.
    expect(store.getProfile().map((e) => e.content)).toEqual(["name: Odin"]);
    store.close();
  });
});

const SILENT: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
const ACTIVE_PROJECT = "project:boot";
const LAST_SUMMARY = "we were migrating the sync queue";
const FAR_PROMPT = "something unrelated entirely";

const seedProjectSummaryOnly = () => {
  const replica = createOrgReplica(join(home, "org-replica.db"));
  replica.upsertMemory({
    id: "memory:last-session",
    content: LAST_SUMMARY,
    type: "summary",
    project_id: ACTIVE_PROJECT,
    created_at: "2026-11-09 09:00:00",
    embedding: [0, 0, 1],
  });
  replica.close();
};

describe("buildSessionContext", () => {
  test("default budgets are the boot ones: session start brings the project's summary even far from the prompt", async () => {
    seedProjectSummaryOnly();
    const block = await buildSessionContext(FAR_PROMPT, ACTIVE_PROJECT, SILENT);
    expect(block).toContain(LAST_SUMMARY);
  });

  test("an empty budgets object means retrieval's defaults, with no session-start behaviour", async () => {
    seedProjectSummaryOnly();
    expect(
      await buildSessionContext(FAR_PROMPT, ACTIVE_PROJECT, SILENT, {}),
    ).toBeNull();
  });

  test("given budgets reach retrieval", async () => {
    seedProjectSummaryOnly();
    expect(
      await buildSessionContext(FAR_PROMPT, ACTIVE_PROJECT, SILENT, {
        sessionStart: true,
      }),
    ).toContain(LAST_SUMMARY);
    expect(
      await buildSessionContext(FAR_PROMPT, ACTIVE_PROJECT, SILENT, {
        sessionStart: true,
        summaryCount: 0,
      }),
    ).toBeNull();
  });

  test("returns null when the replica has nothing for the query", async () => {
    expect(
      await buildSessionContext(FAR_PROMPT, ACTIVE_PROJECT, SILENT),
    ).toBeNull();
  });

  test("returns null when the replica cannot be opened", async () => {
    // A directory is not an openable sqlite file.
    process.env.MIMIR_ORG_REPLICA_DB = home;
    expect(
      await buildSessionContext(FAR_PROMPT, ACTIVE_PROJECT, SILENT),
    ).toBeNull();
  });
});
