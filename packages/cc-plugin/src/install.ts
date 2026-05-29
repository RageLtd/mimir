/**
 * Install subcommand — lands every Mimir runtime artifact on the user's
 * machine. After this runs, the plugin itself is no longer required; the
 * `mimir` wrapper script + ~/.mimir/ contents are self-sufficient.
 *
 * Steps in order:
 *   1. Validate the mimir-server URL.
 *   2. Fetch the canonical system prompt from /v1/system-prompt.
 *   3. Convert it to Anthropic-optimised XML (toAnthropicXml).
 *   4. Materialise ~/.mimir/{system-prompt.md, mcp.json, settings.json,
 *      config.json}.
 *   5. Materialise ~/.local/bin/{mimir, mimir-cc}.
 *
 * Templates are bundled into the compiled binary as text imports so the
 * installer is a single self-contained executable — no sidecar files to
 * ship beside it.
 */

import { chmod, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import mcpTemplate from "../artifacts/mcp.json.template" with { type: "text" };
import settingsTemplate from "../artifacts/settings.json.template" with {
  type: "text",
};
import wrapperTemplate from "../artifacts/wrapper.sh.template" with {
  type: "text",
};

import { writeConfig } from "./config";
import { toAnthropicXml } from "./markdown-to-xml";
import { mimirHome } from "./util";

type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = (error: string): Result<never> => ({ ok: false, error });

type SystemPromptResponse = {
  readonly content?: unknown;
  readonly version?: unknown;
};

const validateUrl = (raw: string): Result<URL> => {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return err(`Invalid URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return err(`URL must be http or https: ${raw}`);
  }
  return ok(parsed);
};

const fetchSystemPrompt = async (
  baseUrl: URL,
): Promise<Result<{ content: string; version: string }>> => {
  // Allow base URL with or without a trailing slash; /v1/system-prompt is
  // always relative to the root of mimir-server.
  const endpoint = new URL("/v1/system-prompt", baseUrl);

  let response: Response;
  try {
    response = await fetch(endpoint);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Fetch failed for ${endpoint.toString()}: ${msg}`);
  }

  if (!response.ok) {
    return err(
      `Fetch failed for ${endpoint.toString()}: ${response.status} ${response.statusText}`,
    );
  }

  let payload: SystemPromptResponse;
  try {
    payload = (await response.json()) as SystemPromptResponse;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return err(`Invalid JSON from ${endpoint.toString()}: ${msg}`);
  }

  if (typeof payload.content !== "string" || payload.content.length === 0) {
    return err(`Response from ${endpoint.toString()} missing 'content' string`);
  }
  const version =
    typeof payload.version === "string" ? payload.version : "unknown";

  return ok({ content: payload.content, version });
};

const ensureDir = async (path: string) => {
  await mkdir(path, { recursive: true });
};

const writeText = async (path: string, contents: string) => {
  await ensureDir(dirname(path));
  await Bun.write(path, contents);
};

const writeExecutable = async (path: string, contents: string) => {
  await writeText(path, contents);
  await chmod(path, 0o755);
};

/**
 * In the compiled binary, process.execPath points at the binary itself —
 * exactly what needs landing at ~/.local/bin/mimir-cc. During `bun src/cli.ts`
 * dev runs, process.execPath is the bun runtime; copying that as mimir-cc
 * would be useless, so skip and tell the developer how to proceed.
 */
const installSelfBinary = async (
  destination: string,
): Promise<Result<true>> => {
  const source = process.execPath;
  const sourceBase = source.split("/").pop() ?? "";

  if (sourceBase === "bun" || sourceBase === "bun-debug") {
    return err(
      `Running under bun (${source}) — refusing to copy the runtime as mimir-cc. ` +
        `Build the binary with ./build.sh and run the compiled output instead.`,
    );
  }

  await ensureDir(dirname(destination));
  await copyFile(source, destination);
  await chmod(destination, 0o755);
  return ok(true);
};

export type InstallOptions = {
  readonly serverUrl: string;
  /** Defaults to ~/.mimir/user-memories.db when omitted. */
  readonly userMemoryDb?: string;
  /** When omitted, the cartographer MCP entry is skipped and reindex is disabled. */
  readonly cartographerBinary?: string;
};

type RenderedTemplates = {
  readonly mcp: string;
  readonly settings: string;
};

/**
 * Render the mcp.json template, conditionally injecting the cartographer
 * entry. We splice the JSON before serialising rather than running string
 * replacements on a template that would leave an orphan comma — the
 * template's placeholder gets replaced with either a valid block + trailing
 * comma or removed entirely.
 */
const renderMcp = (opts: {
  readonly serverUrl: string;
  readonly userMemoryDb: string;
  readonly cartographerBinary?: string;
  readonly selfPath: string;
}): string => {
  const baseForMcp = opts.serverUrl.replace(/\/+$/, "");

  let rendered = mcpTemplate
    .replaceAll("{{MIMIR_SERVER_URL}}", baseForMcp)
    .replaceAll("{{MIMIR_CC_BIN}}", opts.selfPath)
    .replaceAll("{{USER_MEMORY_DB}}", opts.userMemoryDb);

  if (opts.cartographerBinary) {
    rendered = rendered.replace(
      "{{CARTOGRAPHER_BLOCK}}",
      `"cartographer": { "command": "${opts.cartographerBinary}", "args": ["--parse-only"] },\n    `,
    );
  } else {
    rendered = rendered.replace("{{CARTOGRAPHER_BLOCK}}", "");
  }

  return rendered;
};

const renderSettings = (opts: { readonly selfPath: string }): string =>
  settingsTemplate.replaceAll("{{MIMIR_CC_BIN}}", opts.selfPath);

const buildTemplates = (opts: {
  readonly serverUrl: string;
  readonly userMemoryDb: string;
  readonly cartographerBinary?: string;
  readonly selfPath: string;
}): RenderedTemplates => ({
  mcp: renderMcp(opts),
  settings: renderSettings({ selfPath: opts.selfPath }),
});

export const runInstall = async (
  opts: InstallOptions,
): Promise<Result<{ home: string; binDir: string; version: string }>> => {
  const urlResult = validateUrl(opts.serverUrl);
  if (!urlResult.ok) return urlResult;

  const promptResult = await fetchSystemPrompt(urlResult.value);
  if (!promptResult.ok) return promptResult;

  const xml = toAnthropicXml(promptResult.value.content);

  const home = mimirHome();
  const binDir = join(homedir(), ".local", "bin");

  const userMemoryDb = opts.userMemoryDb ?? join(home, "user-memories.db");

  const promptPath = join(home, "system-prompt.md");
  const mcpPath = join(home, "mcp.json");
  const settingsPath = join(home, "settings.json");
  const wrapperPath = join(binDir, "mimir");
  const selfPath = join(binDir, "mimir-cc");

  const templates = buildTemplates({
    serverUrl: opts.serverUrl,
    userMemoryDb,
    cartographerBinary: opts.cartographerBinary,
    selfPath,
  });

  await writeText(promptPath, xml);
  await writeText(mcpPath, templates.mcp);
  await writeText(settingsPath, templates.settings);
  await writeExecutable(wrapperPath, wrapperTemplate);

  await writeConfig({
    serverUrl: opts.serverUrl.replace(/\/+$/, ""),
    userMemoryDb,
    ...(opts.cartographerBinary
      ? { cartographerBinary: opts.cartographerBinary }
      : {}),
  });

  const selfResult = await installSelfBinary(selfPath);
  if (!selfResult.ok) return selfResult;

  return ok({ home, binDir, version: promptResult.value.version });
};

/**
 * CLI entry point — called from cli.ts. Prints user-facing output and
 * translates Result into a process exit code.
 */
export const runInstallCommand = async (
  opts: InstallOptions,
): Promise<number> => {
  if (!opts.serverUrl) {
    console.error(
      "Usage: mimir-cc install <mimir-server-url> [--user-memory-db PATH] [--cartographer PATH]\n" +
        "  e.g. mimir-cc install https://mimir.example.com",
    );
    return 1;
  }

  const result = await runInstall(opts);
  if (!result.ok) {
    console.error(`Install failed: ${result.error}`);
    return 1;
  }

  const { home, binDir, version } = result.value;
  const carto = opts.cartographerBinary
    ? `  Cartographer:   ${opts.cartographerBinary}`
    : `  Cartographer:   (not configured — auto-reindex disabled)`;

  console.log(
    [
      `Mimir installed.`,
      ``,
      `  System prompt:  ${home}/system-prompt.md  (version ${version})`,
      `  MCP config:     ${home}/mcp.json`,
      `  Hook settings:  ${home}/settings.json`,
      `  Runtime config: ${home}/config.json`,
      `  User memories:  ${opts.userMemoryDb ?? join(home, "user-memories.db")}`,
      carto,
      `  Wrapper:        ${binDir}/mimir`,
      `  Binary:         ${binDir}/mimir-cc`,
      `  Logs:           ${home}/logs/mimir-cc.log`,
      ``,
      `Make sure ${binDir} is on your PATH, then exit Claude Code and run`,
      `  mimir`,
      `to start a Mimir session.`,
    ].join("\n"),
  );
  return 0;
};
