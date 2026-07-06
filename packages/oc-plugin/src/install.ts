/**
 * Mimir install for OpenCode.
 *
 * Writes the runtime files the plugin needs into the user's home
 * directory:
 *
 *   ~/.mimir/system-prompt.md        — fetched from <server>/v1/system-prompt
 *   ~/.mimir/config.json             — the user's input (server, db, etc.)
 *   ~/.mimir/logs/                   — created
 *   ~/.config/opencode/opencode.json — OpenCode config (plugin ref, MCP)
 *   ~/.config/opencode/agents/mimir.md — the Mimir custom agent
 *   ~/.local/bin/mimir               — wrapper script (chmod 755)
 *
 * The plugin bundle at `~/.config/opencode/plugins/mimir-oc.ts` is the
 * user's responsibility to download — the install verifies it exists
 * and refuses to proceed if not. Restarting OpenCode after the install
 * is also the user's responsibility.
 *
 * The cloud server requires `MIMIR_API_KEY` in the environment. The
 * install checks the env var first; absent that, the user can pass
 * `apiKey` directly, but the slash command's prompt is built around
 * the env-var flow.
 */

import { chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { errMessage, mimirHome } from "@mimir/plugin-core/util";
import agentTemplate from "../artifacts/agent-mimir.md.template" with {
  type: "text",
};
import opencodeTemplate from "../artifacts/opencode.json.template" with {
  type: "text",
};
import wrapperTemplate from "../artifacts/wrapper.sh.template" with {
  type: "text",
};
import installCommand from "../commands/mimir-install.md" with { type: "text" };
import updateCommand from "../commands/mimir-update.md" with { type: "text" };
import { type MimirConfig, writeConfig } from "./config";

const SYSTEM_PROMPT_ROUTE = "/v1/system-prompt";

type SystemPromptResponse = {
  readonly content?: unknown;
  readonly version?: unknown;
};

export type InstallOptions = {
  readonly serverUrl: string;
  readonly userMemoryDb?: string;
  readonly cartographerBinary?: string;
  readonly apiKey?: string;
};

export type InstallResult = {
  readonly ok: boolean;
  readonly message: string;
  readonly written: readonly string[];
};

const resolveApiKey = (opts: InstallOptions): string | undefined =>
  opts.apiKey ?? process.env.MIMIR_API_KEY;

/**
 * Fetch the system prompt from the server. Returns the content as a
 * string. Throws on any non-2xx, with the response body in the message
 * for the install result.
 */
const fetchSystemPrompt = async (
  serverUrl: string,
  apiKey: string,
): Promise<{ content: string; version: string }> => {
  const url = `${serverUrl.replace(/\/+$/, "")}${SYSTEM_PROMPT_ROUTE}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `System prompt fetch failed: ${response.status} ${response.statusText} — ${body}`,
    );
  }
  const payload = (await response.json()) as SystemPromptResponse;
  if (typeof payload.content !== "string" || payload.content.length === 0) {
    throw new Error("Server response missing 'content' string");
  }
  const version =
    typeof payload.version === "string" ? payload.version : "unknown";
  return { content: payload.content, version };
};

const writeText = async (path: string, content: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, content);
};

const renderTemplate = (
  template: string,
  vars: Readonly<Record<string, string>>,
): string => {
  let out = template;
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out;
};

/**
 * Run the install. Returns a result object the calling tool can
 * serialise back to the model — `ok: true` and a summary of what was
 * written, or `ok: false` and an actionable error message.
 *
 * Idempotent: re-running on a populated directory overwrites the
 * files with the new options. The plugin bundle is the user's
 * responsibility to install (via `opencode plugin @RageLtd/mimir-oc`);
 * this function runs in-process inside the loaded plugin, so the bundle
 * is necessarily already present by the time we're called.
 */
export const installMimir = async (
  opts: InstallOptions,
): Promise<InstallResult> => {
  const written: string[] = [];

  // 1. Validate server URL.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(opts.serverUrl);
  } catch {
    return {
      ok: false,
      message: `Invalid serverUrl: ${opts.serverUrl}`,
      written,
    };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return {
      ok: false,
      message: `serverUrl must be http or https: ${opts.serverUrl}`,
      written,
    };
  }

  // 2. Resolve and check the API key. Cloud server requires it; some
  //    self-hosted servers don't. We pass it through regardless; a
  //    401/403 surfaces as a fetch failure.
  const apiKey = resolveApiKey(opts);
  if (!apiKey) {
    return {
      ok: false,
      message:
        "MIMIR_API_KEY is not set. Export it (e.g. `export MIMIR_API_KEY=...`) and run /mimir-install again.",
      written,
    };
  }

  // 3. Fetch the system prompt.
  let promptContent: string;
  let promptVersion: string;
  try {
    const fetched = await fetchSystemPrompt(opts.serverUrl, apiKey);
    promptContent = fetched.content;
    promptVersion = fetched.version;
  } catch (err) {
    return {
      ok: false,
      message: `Failed to fetch system prompt: ${errMessage(err)}`,
      written,
    };
  }
  // 4. Write the Mimir state directory.
  const home = mimirHome();
  const userMemoryDb = opts.userMemoryDb ?? join(home, "user-memories.db");

  const promptPath = join(home, "system-prompt.md");
  const configPath = join(home, "config.json");
  const logsDir = join(home, "logs");

  try {
    await writeText(promptPath, promptContent);
    written.push(promptPath);
  } catch (err) {
    return {
      ok: false,
      message: `Failed to write system prompt: ${errMessage(err)}`,
      written,
    };
  }

  const mimirConfig: MimirConfig = {
    serverUrl: opts.serverUrl.replace(/\/+$/, ""),
    userMemoryDb,
    ...(opts.cartographerBinary
      ? { cartographerBinary: opts.cartographerBinary }
      : {}),
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
  };
  try {
    await writeConfig(mimirConfig);
    written.push(configPath);
  } catch (err) {
    return {
      ok: false,
      message: `Failed to write Mimir config: ${errMessage(err)}`,
      written,
    };
  }

  try {
    await mkdir(logsDir, { recursive: true });
    written.push(logsDir);
  } catch (err) {
    return {
      ok: false,
      message: `Failed to create logs directory: ${errMessage(err)}`,
      written,
    };
  }

  // 5. Write the OpenCode config.
  const opencodeConfigPath = join(
    process.env.HOME ?? "~",
    ".config",
    "opencode",
    "opencode.json",
  );
  const agentPath = join(
    process.env.HOME ?? "~",
    ".config",
    "opencode",
    "agents",
    "mimir.md",
  );
  const wrapperPath = join(process.env.HOME ?? "~", ".local", "bin", "mimir");
  const installCommandPath = join(
    process.env.HOME ?? "~",
    ".config",
    "opencode",
    "commands",
    "mimir-install.md",
  );
  const updateCommandPath = join(
    process.env.HOME ?? "~",
    ".config",
    "opencode",
    "commands",
    "mimir-update.md",
  );

  const tplVars = {
    SERVER_URL: mimirConfig.serverUrl,
    USER_MEMORY_DB: mimirConfig.userMemoryDb,
  };

  try {
    await writeText(
      opencodeConfigPath,
      renderTemplate(opencodeTemplate, tplVars),
    );
    written.push(opencodeConfigPath);
  } catch (err) {
    return {
      ok: false,
      message: `Failed to write opencode config: ${errMessage(err)}`,
      written,
    };
  }

  try {
    await writeText(agentPath, renderTemplate(agentTemplate, tplVars));
    written.push(agentPath);
  } catch (err) {
    return {
      ok: false,
      message: `Failed to write Mimir agent: ${errMessage(err)}`,
      written,
    };
  }

  // 6. Write the wrapper script and make it executable.
  try {
    await writeText(wrapperPath, renderTemplate(wrapperTemplate, tplVars));
    await chmod(wrapperPath, 0o755);
    written.push(wrapperPath);
  } catch (err) {
    return {
      ok: false,
      message: `Failed to write wrapper script: ${errMessage(err)}`,
      written,
    };
  }

  // 7. Write the slash commands so the user can trigger the install
  //    and update from inside OpenCode.
  try {
    await writeText(installCommandPath, installCommand);
    written.push(installCommandPath);
  } catch (err) {
    return {
      ok: false,
      message: `Failed to write install slash command: ${errMessage(err)}`,
      written,
    };
  }

  try {
    await writeText(updateCommandPath, updateCommand);
    written.push(updateCommandPath);
  } catch (err) {
    return {
      ok: false,
      message: `Failed to write update slash command: ${errMessage(err)}`,
      written,
    };
  }

  return {
    ok: true,
    message: [
      `Mimir installed (system prompt version ${promptVersion}).`,
      "",
      "Wrote:",
      ...written.map((p) => `  ${p}`),
      "",
      "Next: restart OpenCode so it loads the plugin and the new config.",
    ].join("\n"),
    written,
  };
};
