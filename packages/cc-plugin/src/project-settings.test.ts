import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  disableProject,
  enableProject,
  OUTPUT_STYLE_NAME,
  parseSwitchArgs,
  resolvePluginKey,
  runDisableCommand,
  runEnableCommand,
} from "./project-settings";

const KEY = "mimir-cc@rageltd";

describe("enableProject", () => {
  test("empty settings gain the plugin, the style, and the template slice", () => {
    const out = enableProject({}, KEY);
    expect(out.enabledPlugins).toEqual({ [KEY]: true });
    expect(out.outputStyle).toBe(OUTPUT_STYLE_NAME);
    expect(out.env).toEqual({
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: "3",
      CLAUDE_CODE_SUBAGENT_MODEL: "opus",
    });
    expect(out.worktree).toEqual({ baseRef: "head" });
    expect(out.permissions.deny).toContain("Read(**/.env)");
    // Wrapper-only keys stay out of a project file.
    expect(out).not.toHaveProperty("disableAgentView");
  });

  test("preserves unrelated settings and dedupes deny entries", () => {
    const out = enableProject(
      {
        model: "opus",
        enabledPlugins: { "other@m": true },
        permissions: {
          allow: ["Bash(ls)"],
          deny: ["Read(**/.env)", "Read(secret)"],
        },
      },
      KEY,
    );
    expect(out).toMatchObject({ model: "opus" });
    expect(out.enabledPlugins).toEqual({ "other@m": true, [KEY]: true });
    expect(out.permissions).toMatchObject({ allow: ["Bash(ls)"] });
    const deny = out.permissions.deny;
    expect(deny.filter((d) => d === "Read(**/.env)")).toHaveLength(1);
    expect(deny).toContain("Read(secret)");
  });
});

describe("disableProject", () => {
  test("exactly reverses enable on an empty file", () => {
    expect(disableProject(enableProject({}, KEY), KEY)).toEqual({});
  });

  test("keeps the developer's own entries and values they changed", () => {
    const enabled = enableProject(
      {
        enabledPlugins: { "other@m": true },
        permissions: { deny: ["Read(secret)"] },
      },
      KEY,
    );
    const tweaked = {
      ...enabled,
      env: { ...enabled.env, CLAUDE_CODE_SUBAGENT_MODEL: "sonnet", MINE: "1" },
      outputStyle: "Concise",
    };
    expect(disableProject(tweaked, KEY)).toEqual({
      enabledPlugins: { "other@m": true },
      env: { CLAUDE_CODE_SUBAGENT_MODEL: "sonnet", MINE: "1" },
      permissions: { deny: ["Read(secret)"] },
      outputStyle: "Concise",
    });
  });
});

describe("resolvePluginKey", () => {
  test("finds the installed mimir-cc key whatever marketplace it came from", () => {
    expect(
      resolvePluginKey({
        plugins: { "context7@official": [], "mimir-cc@mimir-cc-local": [] },
      }),
    ).toBe("mimir-cc@mimir-cc-local");
  });

  test("falls back to the public marketplace key", () => {
    expect(resolvePluginKey(null)).toBe(KEY);
    expect(resolvePluginKey({ plugins: {} })).toBe(KEY);
  });
});

describe("parseSwitchArgs", () => {
  test("reads --project and --plugin, rejects the rest", () => {
    const parsed = parseSwitchArgs(["--project", "/p", "--plugin", "k"]);
    expect(parsed).toEqual({ projectDir: "/p", pluginKey: "k" });
    expect(parseSwitchArgs(["--project"])).toEqual({
      error: "--project requires a value",
    });
    expect(parseSwitchArgs(["--bogus", "x"])).toEqual({
      error: "unknown flag: --bogus",
    });
  });
});

describe("enable / disable commands", () => {
  let project = "";
  let configDir = "";
  let savedConfigDir: string | undefined;

  beforeEach(async () => {
    project = await mkdtemp(join(tmpdir(), "mimir-project-"));
    configDir = await mkdtemp(join(tmpdir(), "mimir-claude-"));
    savedConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = savedConfigDir;
    await rm(project, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  });

  const settingsPath = () => join(project, ".claude", "settings.local.json");

  test("enable creates the file using the installed plugin key; disable removes it", async () => {
    await mkdir(join(configDir, "plugins"), { recursive: true });
    await writeFile(
      join(configDir, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "mimir-cc@mimir-cc-local": [] } }),
    );

    expect(await runEnableCommand(["--project", project])).toBe(0);
    const written = await Bun.file(settingsPath()).json();
    expect(written.enabledPlugins).toEqual({ "mimir-cc@mimir-cc-local": true });
    expect(written.outputStyle).toBe(OUTPUT_STYLE_NAME);

    expect(await runDisableCommand(["--project", project])).toBe(0);
    expect(await Bun.file(settingsPath()).exists()).toBe(false);
  });

  test("refuses to touch a file it cannot parse", async () => {
    await mkdir(join(project, ".claude"), { recursive: true });
    await writeFile(settingsPath(), "{ not json");
    expect(await runEnableCommand(["--project", project])).toBe(1);
    expect(await Bun.file(settingsPath()).text()).toBe("{ not json");
  });
});
