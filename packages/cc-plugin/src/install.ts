/**
 * Install subcommand — lands every Mimir runtime artifact on the user's
 * machine. Hooks and MCP servers ship inside the plugin (hooks/hooks.json,
 * .mcp.json), so the install lands only what has to be rendered per
 * machine: the persona, the wrapper's settings, the runtime config, and
 * the binaries.
 *
 * Steps in order:
 *   1. Validate the mimir-server URL.
 *   2. Fetch the canonical system prompt from /v1/system-prompt.
 *   3. Convert it to Anthropic-optimised XML (toAnthropicXml).
 *   4. Materialise ~/.mimir/{system-prompt.md, settings.json, config.json}
 *      and the "Mimir" output style under Claude Code's config dir — the
 *      persona a desktop-app session selects per project (`mimir-cc enable`).
 *   5. Materialise ~/.local/bin/{mimir, mimir-cc}.
 *
 * Templates are bundled into the compiled binary as text imports so the
 * installer is a single self-contained executable — no sidecar files to
 * ship beside it.
 */

import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { toAnthropicXml } from "@mimir/plugin-core/anthropic-xml";
import { embedderDir } from "@mimir/plugin-core/brain/embedder";
import { installEmbedderArtifacts } from "@mimir/plugin-core/brain/embedder-install";
import { resolveCartographerBinary } from "@mimir/plugin-core/cartographer/resolve";
import { mimirHome } from "@mimir/plugin-core/util";
import settingsTemplate from "../artifacts/settings.json.template" with {
  type: "text",
};
import wrapperTemplate from "../artifacts/wrapper.sh.template" with {
  type: "text",
};
import ensureBinaryScript from "../scripts/ensure-binary.sh" with {
  type: "text",
};
import { extractionConfig, readConfig, writeConfig } from "./config";
import { claudeConfigDir, OUTPUT_STYLE_NAME } from "./project-settings";

// `as const` keeps the discriminant literal so the ok/err union
// discriminates without a return annotation blinding the compiler.
const ok = <T>(value: T) => ({ ok: true as const, value });
const err = (error: string) => ({ ok: false as const, error });

type SystemPromptResponse = {
  readonly content?: unknown;
  readonly version?: unknown;
};

const validateUrl = (raw: string) => {
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

const fetchSystemPrompt = async (baseUrl: URL, apiKey?: string) => {
  // Allow base URL with or without a trailing slash; /v1/system-prompt is
  // always relative to the root of mimir-server.
  const endpoint = new URL("/v1/system-prompt", baseUrl);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    });
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
const installSelfBinary = async (destination: string) => {
  const source = process.execPath;
  const sourceBase = source.split("/").pop() ?? "";

  if (sourceBase === "bun" || sourceBase === "bun-debug") {
    return err(
      `Running under bun (${source}) — refusing to copy the runtime as mimir-cc. ` +
        `Build the binary with ./build.sh and run the compiled output instead.`,
    );
  }

  // In the release-install flow, ensure-binary.sh has already downloaded the
  // binary to the destination, so process.execPath IS the destination. Copying
  // a file onto itself truncates it to zero — skip the copy and just confirm
  // the mode.
  if (resolve(source) === resolve(destination)) {
    await chmod(destination, 0o755);
    return ok(true);
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
  /** Static bearer key for the interim API gate (MIM-77). Omit for
   *  ungated self-hosted servers. */
  readonly apiKey?: string;
  /** BYOK provider key for persist-spawned background inference (MIM-74). */
  readonly providerApiKey?: string;
  /** Provider id (models.dev key) paired with providerApiKey. */
  readonly provider?: string;
  /** Small/cheap model for the spawned background jobs. */
  readonly smallModel?: string;
  /** MIM-86 extraction endpoint — without it (or the MIMIR_EXTRACTION_*
   *  env) memory distillation is OFF. Key stays env-only (no-paste). */
  readonly extractionBaseUrl?: string;
  readonly extractionModel?: string;
};

/**
 * The persona as a Claude Code output style. A custom style replaces
 * Claude Code's software-engineering instructions with its body while the
 * rest of the default prompt stays — the closest a flag-less session (the
 * desktop app) gets to the wrapper's full replacement. Not forced for the
 * plugin: a forced style would also stack onto wrapper sessions, which
 * already carry the prompt via --system-prompt-file. Projects select it
 * through `mimir-cc enable`.
 */
export const renderOutputStyle = (xml: string) =>
  [
    "---",
    `name: ${OUTPUT_STYLE_NAME}`,
    "description: Mimir persona — served by mimir-server, installed by mimir-cc. Select per project with `mimir-cc enable`.",
    "---",
    "",
    xml,
    "",
  ].join("\n");

const outputStylePath = () =>
  join(claudeConfigDir(), "output-styles", "mimir.md");

export const runInstall = async (
  opts: InstallOptions,
  log: (message: string) => void = () => {},
) => {
  const urlResult = validateUrl(opts.serverUrl);
  if (!urlResult.ok) return urlResult;

  // Resolve the cartographer binary BEFORE the server fetch: an explicit
  // --cartographer path is validated (a typo'd path used to install
  // "successfully" with the index legs permanently dark); otherwise the
  // latest GitHub release is downloaded into ~/.mimir/bin. Indexing is
  // always on.
  const carto = await resolveCartographerBinary({
    ...(opts.cartographerBinary ? { requested: opts.cartographerBinary } : {}),
    log,
  });
  if (!carto.ok) return err(carto.error);
  const cartographerBinary = carto.binary;

  const promptResult = await fetchSystemPrompt(urlResult.value, opts.apiKey);
  if (!promptResult.ok) return promptResult;

  const xml = toAnthropicXml(promptResult.value.content);

  const home = mimirHome();
  const binDir = join(homedir(), ".local", "bin");

  const userMemoryDb = opts.userMemoryDb ?? join(home, "user-memories.db");

  const promptPath = join(home, "system-prompt.md");
  const settingsPath = join(home, "settings.json");
  const stylePath = outputStylePath();
  const wrapperPath = join(binDir, "mimir");
  const selfPath = join(binDir, "mimir-cc");

  const ensureBinaryPath = join(home, "ensure-binary.sh");

  await writeText(promptPath, xml);
  await writeText(stylePath, renderOutputStyle(xml));
  await writeText(settingsPath, settingsTemplate);
  // Retired files an update removes: workers moved into the plugin's
  // agents/ directory; MCP servers moved into the plugin's .mcp.json (a
  // stale mcp.json is harmless — the wrapper no longer passes it — but
  // leaving it invites someone to edit the wrong file).
  await rm(join(home, "agents.json"), { force: true });
  await rm(join(home, "mcp.json"), { force: true });
  await writeExecutable(wrapperPath, wrapperTemplate);
  // The wrapper self-updates the binary on launch by running this from
  // ~/.mimir, so it must not depend on the plugin clone still being present.
  await writeExecutable(ensureBinaryPath, ensureBinaryScript);

  // MERGE over the existing shared config rather than replacing it:
  // fields this installer doesn't carry in InstallOptions (the MIM-86
  // extraction trio, anything another distribution recorded) must
  // survive an install/update — a blind overwrite silently dropped them.
  const existingConfig = await readConfig();
  await writeConfig({
    ...(existingConfig ?? {}),
    serverUrl: opts.serverUrl.replace(/\/+$/, ""),
    userMemoryDb,
    cartographerBinary,
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.providerApiKey ? { providerApiKey: opts.providerApiKey } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.smallModel ? { smallModel: opts.smallModel } : {}),
    ...(opts.extractionBaseUrl
      ? { extractionBaseUrl: opts.extractionBaseUrl }
      : {}),
    ...(opts.extractionModel ? { extractionModel: opts.extractionModel } : {}),
  });

  // MIM-85: embedder artifacts (pinned llama.cpp release + hash-verified
  // GGUF, ~640MB on first run). A failure fails the WHOLE install — no
  // silent text-only installs; re-run once the network/mirror recovers.
  const embedderErr = await installEmbedderArtifacts(log);
  if (embedderErr) {
    return err(`Embedder install failed: ${embedderErr.message}`);
  }

  const selfResult = await installSelfBinary(selfPath);
  if (!selfResult.ok) return selfResult;

  return ok({
    home,
    binDir,
    stylePath,
    version: promptResult.value.version,
    cartographerBinary,
  });
};

/**
 * CLI entry point — called from cli.ts. Prints user-facing output and
 * translates Result into a process exit code.
 */
export const runInstallCommand = async (opts: InstallOptions) => {
  if (!opts.serverUrl) {
    console.error(
      "Usage: mimir-cc install <mimir-server-url> [--user-memory-db PATH] [--cartographer PATH]\n" +
        "  e.g. mimir-cc install https://mimir.example.com",
    );
    return 1;
  }

  const result = await runInstall(opts, (msg) => console.log(`  ${msg}`));
  if (!result.ok) {
    console.error(`Install failed: ${result.error}`);
    return 1;
  }

  const { home, binDir, stylePath, version, cartographerBinary } = result.value;
  const carto = `  Cartographer:   ${cartographerBinary}`;

  // Effective extraction status AFTER config write (env wins over
  // config) — the brain silently distills nothing without it, so the
  // install summary states it loudly instead of leaving a per-turn log
  // warning as the only symptom.
  const extraction = await extractionConfig();
  const extractionLine = extraction
    ? `  Extraction:     ${extraction.model} via ${extraction.baseUrl}`
    : `  Extraction:     NOT CONFIGURED — memory distillation is OFF.\n` +
      `                  Set --extraction-base-url + --extraction-model` +
      ` (or MIMIR_EXTRACTION_* env) and re-run update.`;

  console.log(
    [
      `Mimir installed.`,
      ``,
      `  System prompt:  ${home}/system-prompt.md  (version ${version})`,
      `  Output style:   ${stylePath}  ("${OUTPUT_STYLE_NAME}")`,
      `  Settings:       ${home}/settings.json  (wrapper sessions)`,
      `  Runtime config: ${home}/config.json`,
      `  User memories:  ${opts.userMemoryDb ?? join(home, "user-memories.db")}`,
      `  Embedder:       ${embedderDir()}  (llama.cpp + pinned GGUF)`,
      carto,
      extractionLine,
      `  Wrapper:        ${binDir}/mimir`,
      `  Binary:         ${binDir}/mimir-cc`,
      `  Updater:        ${home}/ensure-binary.sh`,
      `  Logs:           ${home}/logs/mimir-cc.log`,
      ``,
      `Hooks and MCP servers ship inside the mimir-cc plugin, so a session is`,
      `Mimir wherever that plugin is enabled. Two ways in:`,
      ``,
      `  Claude desktop app / plain claude:  run \`${binDir}/mimir-cc enable\``,
      `      in a project to turn Mimir on there (and only there), then open`,
      `      a new session in it.`,
      `  Terminal:  make sure ${binDir} is on your PATH and run \`mimir\` —`,
      `      full persona prompt plus /switch-model.`,
    ].join("\n"),
  );
  return 0;
};
