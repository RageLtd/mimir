/**
 * Per-project Mimir switch — `mimir-cc enable` / `mimir-cc disable`.
 *
 * The Claude desktop app spawns `claude` with no flags, so a session can
 * only become Mimir through what Claude Code loads on its own. The plugin
 * carries the hooks (hooks/hooks.json) and MCP servers (.mcp.json); the
 * persona is the "Mimir" output style the installer writes. Where the
 * plugin is enabled is therefore where Mimir is active — and Claude Code
 * scopes plugin enablement per settings file. Enabling in a project's
 * `.claude/settings.local.json` (per-user, gitignored, copied into the
 * worktrees the desktop app creates) turns Mimir on for that project and
 * nowhere else.
 *
 * `enable` merges into that file: the plugin, the output style, and the
 * slice of the wrapper's settings a desktop session would otherwise lack
 * (subagent env, worktree base ref, secret-file deny list). `disable`
 * removes exactly what `enable` added, leaving the developer's own
 * entries — including a value they changed after enabling — untouched.
 */

import { rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { attempt } from "@mimir/plugin-core/result";
import settingsTemplate from "../artifacts/settings.json.template" with {
  type: "text",
};

export const OUTPUT_STYLE_NAME = "Mimir";
export const PLUGIN_NAME = "mimir-cc";
const DEFAULT_PLUGIN_KEY = `${PLUGIN_NAME}@rageltd`;
const LOCAL_SETTINGS_PATH = join(".claude", "settings.local.json");

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const recordAt = (obj: Json, key: string) => {
  const value = obj[key];
  return isRecord(value) ? value : {};
};

const stringsAt = (obj: Json, key: string) => {
  const value = obj[key];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
};

/** Claude Code's own config dir — honours the same override claude does. */
export const claudeConfigDir = () =>
  process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");

/**
 * The slice of the wrapper's settings template a project inherits. The
 * template is the single source for these values; `outputStyle` and
 * `disableAgentView` are wrapper-only and deliberately not copied.
 */
const templateSlice = () => {
  // Serialisation boundary: the template is JSON text bundled into the
  // binary, so its shape is only known at runtime.
  const template = JSON.parse(settingsTemplate) as {
    readonly env: Record<string, string>;
    readonly worktree: Record<string, string>;
    readonly permissions: { readonly deny: readonly string[] };
  };
  return {
    env: template.env,
    worktree: template.worktree,
    deny: template.permissions.deny,
  };
};

export const enableProject = (settings: Json, pluginKey: string) => {
  const ours = templateSlice();
  const permissions = recordAt(settings, "permissions");
  return {
    ...settings,
    enabledPlugins: {
      ...recordAt(settings, "enabledPlugins"),
      [pluginKey]: true,
    },
    outputStyle: OUTPUT_STYLE_NAME,
    env: { ...recordAt(settings, "env"), ...ours.env },
    worktree: { ...recordAt(settings, "worktree"), ...ours.worktree },
    permissions: {
      ...permissions,
      deny: [...new Set([...stringsAt(permissions, "deny"), ...ours.deny])],
    },
  };
};

/** Drop the keys whose value is still exactly what `enable` wrote. */
const withoutOurs = (current: Json, ours: Json) =>
  Object.fromEntries(
    Object.entries(current).filter(
      ([key, value]) => !(key in ours) || ours[key] !== value,
    ),
  );

/** Set `key` to `value`, or drop it when `value` is an empty container. */
const setOrDrop = (settings: Json, key: string, value: Json | unknown[]) => {
  const { [key]: _, ...rest } = settings;
  const empty = Array.isArray(value)
    ? value.length === 0
    : Object.keys(value).length === 0;
  return empty ? rest : { ...rest, [key]: value };
};

export const disableProject = (settings: Json, pluginKey: string) => {
  const ours = templateSlice();
  const permissions = recordAt(settings, "permissions");
  const deny = stringsAt(permissions, "deny").filter(
    (entry) => !ours.deny.includes(entry),
  );
  let out = setOrDrop(
    settings,
    "enabledPlugins",
    withoutOurs(recordAt(settings, "enabledPlugins"), { [pluginKey]: true }),
  );
  out = setOrDrop(out, "env", withoutOurs(recordAt(out, "env"), ours.env));
  out = setOrDrop(
    out,
    "worktree",
    withoutOurs(recordAt(out, "worktree"), ours.worktree),
  );
  out = setOrDrop(out, "permissions", setOrDrop(permissions, "deny", deny));
  // Scalar, so the container helpers don't apply: drop it only while it
  // is still the style `enable` selected.
  const { outputStyle, ...rest } = out;
  return outputStyle === OUTPUT_STYLE_NAME ? rest : out;
};

/**
 * The key Claude Code knows this plugin by — `mimir-cc@<marketplace>`.
 * Read from installed_plugins.json so a from-source install
 * (`mimir-cc@mimir-cc-local`) resolves without a flag; the public
 * marketplace key is the fallback.
 */
export const resolvePluginKey = (installed: unknown) => {
  const plugins = isRecord(installed) ? recordAt(installed, "plugins") : {};
  return (
    Object.keys(plugins).find((key) => key.startsWith(`${PLUGIN_NAME}@`)) ??
    DEFAULT_PLUGIN_KEY
  );
};

const readJsonFile = async (path: string) => {
  const file = Bun.file(path);
  if (!(await file.exists())) return { ok: true as const, value: null };
  const [err, parsed] = await attempt(
    async () => file.json() as Promise<unknown>,
  );
  if (err) return { ok: false as const, error: `${path}: ${err.message}` };
  if (!isRecord(parsed)) {
    return { ok: false as const, error: `${path}: expected a JSON object` };
  }
  return { ok: true as const, value: parsed };
};

const installedPluginKey = async () => {
  const installed = await readJsonFile(
    join(claudeConfigDir(), "plugins", "installed_plugins.json"),
  );
  return resolvePluginKey(installed.ok ? installed.value : null);
};

/** True when the plugin is enabled in the user's own settings — i.e.
 *  Mimir is already on in every project, which defeats the per-project
 *  switch. Surfaced as a note, never changed: that file is the user's. */
const enabledAtUserLevel = async (pluginKey: string) => {
  const user = await readJsonFile(join(claudeConfigDir(), "settings.json"));
  return (
    user.ok &&
    user.value !== null &&
    recordAt(user.value, "enabledPlugins")[pluginKey] === true
  );
};

type SwitchArgs = {
  readonly projectDir: string;
  readonly pluginKey?: string;
};

export const parseSwitchArgs = (rest: readonly string[]) => {
  let projectDir = process.cwd();
  let pluginKey: string | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    const [flag, value] = [rest[i], rest[i + 1]];
    if (!value) return { error: `${flag} requires a value` } as const;
    if (flag === "--project") projectDir = resolve(value);
    else if (flag === "--plugin") pluginKey = value;
    else return { error: `unknown flag: ${flag}` } as const;
  }
  const args: SwitchArgs = { projectDir, ...(pluginKey ? { pluginKey } : {}) };
  return args;
};

const runSwitch = async (
  rest: readonly string[],
  apply: (settings: Json, pluginKey: string) => Json,
) => {
  const args = parseSwitchArgs(rest);
  if ("error" in args) {
    console.error(args.error);
    return null;
  }
  const pluginKey = args.pluginKey ?? (await installedPluginKey());
  const path = join(args.projectDir, LOCAL_SETTINGS_PATH);
  const existing = await readJsonFile(path);
  if (!existing.ok) {
    // Never rewrite a file we could not parse — that would discard
    // whatever the developer had in it.
    console.error(`Refusing to modify ${existing.error}`);
    return null;
  }
  const next = apply(existing.value ?? {}, pluginKey);
  if (Object.keys(next).length === 0) {
    await rm(path, { force: true });
  } else {
    await Bun.write(path, `${JSON.stringify(next, null, 2)}\n`);
  }
  return { path, pluginKey };
};

export const runEnableCommand = async (rest: readonly string[]) => {
  const result = await runSwitch(rest, enableProject);
  if (!result) return 1;
  const lines = [
    `Mimir enabled for this project.`,
    ``,
    `  Settings:   ${result.path}`,
    `  Plugin:     ${result.pluginKey}`,
    `  Persona:    output style "${OUTPUT_STYLE_NAME}"`,
    ``,
    `Start a new Claude Code session in this project (desktop app or terminal)`,
    `to pick it up. Running sessions keep their current configuration.`,
  ];
  if (await enabledAtUserLevel(result.pluginKey)) {
    lines.push(
      ``,
      `Note: ${result.pluginKey} is also enabled in ${join(claudeConfigDir(), "settings.json")},`,
      `so its hooks and MCP servers load in EVERY project. Set it to false there`,
      `to scope Mimir to the projects you enable.`,
    );
  }
  console.log(lines.join("\n"));
  return 0;
};

export const runDisableCommand = async (rest: readonly string[]) => {
  const result = await runSwitch(rest, disableProject);
  if (!result) return 1;
  console.log(
    [
      `Mimir disabled for this project.`,
      ``,
      `  Settings:   ${result.path}`,
      ``,
      `Entries Mimir added were removed; anything you changed since was kept.`,
      `Start a new session for the change to take effect.`,
    ].join("\n"),
  );
  return 0;
};
