/**
 * Install subcommand — lands every Mimir-for-Codex runtime artifact on
 * the user's machine. After this runs, the repo clone is no longer
 * required; the `mimir-codex` wrapper + ~/.mimir/codex/ contents are
 * self-sufficient.
 *
 * Steps in order:
 *   1. Validate the mimir-server URL.
 *   2. Fetch the canonical system prompt from /v1/system-prompt.
 *   3. Convert it to XML (toAnthropicXml — the voice-anchor parser
 *      requires the <voice_in_action> block that conversion produces).
 *   4. Materialise ~/.mimir/codex/{AGENTS.md, config.toml} and the
 *      shared ~/.mimir/config.json.
 *   5. Trust the hooks via `codex app-server` hooks/list (Codex silently
 *      skips untrusted hooks — see trust.ts).
 *   6. Materialise ~/.local/bin/{mimir-codex, mimir-codex-acp,
 *      mimir-codex-bin}.
 *
 * Templates are bundled into the compiled binary as text imports so the
 * installer is a single self-contained executable.
 */

import { chmod, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { toAnthropicXml } from "@mimir/plugin-core/anthropic-xml";
import { embedderDir } from "@mimir/plugin-core/brain/embedder";
import { installEmbedderArtifacts } from "@mimir/plugin-core/brain/embedder-install";
import { resolveCartographerBinary } from "@mimir/plugin-core/cartographer/resolve";
import {
  extractionConfig,
  readConfig,
  writeConfig,
} from "@mimir/plugin-core/shared-config";
import { defaultOrgReplicaPath } from "@mimir/plugin-core/store/org-replica";
import { mimirHome } from "@mimir/plugin-core/util";
// Canonical shared updater (plugin-core) — bundled into the compiled binary
// and materialised at ~/.mimir/ensure-binary.sh; the wrapper runs it with the
// `codex` flavor on every launch to track codex-plugin/v* releases.
import ensureBinaryScript from "../../plugin-core/scripts/ensure-binary.sh" with {
  type: "text",
};
import acpWrapperTemplate from "../artifacts/acp-wrapper.sh.template" with {
  type: "text",
};
import configTemplate from "../artifacts/config.toml.template" with {
  type: "text",
};
import wrapperTemplate from "../artifacts/wrapper.sh.template" with {
  type: "text",
};
import { spliceManagedConfig } from "./config-preserve";
import { mimirCodexHome } from "./paths";
import { trustMimirHooks } from "./trust";

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
 * exactly what needs landing at ~/.local/bin/mimir-codex-bin. During
 * `bun src/cli.ts` dev runs, process.execPath is the bun runtime;
 * copying that would be useless, so skip and tell the developer how to
 * proceed.
 */
const installSelfBinary = async (destination: string) => {
  const source = process.execPath;
  const sourceBase = source.split("/").pop() ?? "";

  if (sourceBase === "bun" || sourceBase === "bun-debug") {
    return err(
      `Running under bun (${source}) — refusing to copy the runtime as mimir-codex-bin. ` +
        `Build the binary with ./build.sh and run the compiled output instead.`,
    );
  }

  // If a prior flow already downloaded the binary to the destination,
  // process.execPath IS the destination. Copying a file onto itself
  // truncates it to zero — skip the copy and just confirm the mode.
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
  /** BYOK provider key (MIM-74). */
  readonly providerApiKey?: string;
  /** Provider id (models.dev key) paired with providerApiKey. */
  readonly provider?: string;
  /** Small/cheap model for background jobs + extraction fallback. */
  readonly smallModel?: string;
  /** MIM-86 extraction endpoint — without it (or the MIMIR_EXTRACTION_*
   *  env) memory distillation is OFF. Key stays env-only (no-paste). */
  readonly extractionBaseUrl?: string;
  readonly extractionModel?: string;
};

const renderConfigToml = (opts: {
  readonly serverUrl: string;
  readonly userMemoryDb: string;
  readonly cartographerBinary?: string;
  readonly apiKey?: string;
  readonly selfPath: string;
}) => {
  const base = opts.serverUrl.replace(/\/+$/, "");

  let rendered = configTemplate
    .replaceAll("{{MIMIR_SERVER_URL}}", base)
    .replaceAll("{{MIMIR_CODEX_BIN}}", opts.selfPath)
    .replaceAll("{{USER_MEMORY_DB}}", opts.userMemoryDb)
    .replaceAll("{{ORG_REPLICA_DB}}", defaultOrgReplicaPath())
    // HTTP MCP auth: bearer_token inline is rejected for streamable_http;
    // bearer_token_env_var is the supported shape. The wrapper exports
    // MIMIR_API_KEY from the shared config.
    .replace(
      "{{MIMIR_BEARER_LINE}}",
      opts.apiKey ? `bearer_token_env_var = "MIMIR_API_KEY"` : "",
    );

  if (opts.cartographerBinary) {
    rendered = rendered.replace(
      "{{CARTOGRAPHER_BLOCK}}",
      `[mcp_servers.cartographer]\ncommand = "${opts.cartographerBinary}"\nargs = ["--parse-only"]\n`,
    );
  } else {
    rendered = rendered.replace("{{CARTOGRAPHER_BLOCK}}", "");
  }

  return rendered;
};

export const runInstall = async (
  opts: InstallOptions,
  log: (message: string) => void = () => {},
) => {
  const urlResult = validateUrl(opts.serverUrl);
  if (!urlResult.ok) return urlResult;

  // Resolve the cartographer binary BEFORE any network work: an explicit
  // --cartographer path is validated (a typo'd path used to install
  // "successfully" with the index legs permanently dark), an omitted one
  // auto-detects from $PATH, and only a declined prompt disables indexing.
  const carto = await resolveCartographerBinary({
    ...(opts.cartographerBinary ? { requested: opts.cartographerBinary } : {}),
  });
  if (!carto.ok) return err(carto.error);
  const cartographerBinary = carto.binary ?? undefined;
  if (carto.binary === null) log(`Cartographer: ${carto.reason}`);

  const promptResult = await fetchSystemPrompt(urlResult.value, opts.apiKey);
  if (!promptResult.ok) return promptResult;

  const xml = toAnthropicXml(promptResult.value.content);

  const home = mimirHome();
  const codexHome = mimirCodexHome();
  const binDir = join(homedir(), ".local", "bin");

  const userMemoryDb = opts.userMemoryDb ?? join(home, "user-memories.db");

  const personaPath = join(codexHome, "AGENTS.md");
  const configTomlPath = join(codexHome, "config.toml");
  const wrapperPath = join(binDir, "mimir-codex");
  const acpWrapperPath = join(binDir, "mimir-codex-acp");
  const selfPath = join(binDir, "mimir-codex-bin");

  await writeText(personaPath, xml);

  // Splice the regenerated mimir block into the existing config.toml so
  // codex-written state (project trust_level entries, personality, …)
  // survives an update — see config-preserve.ts.
  const configFile = Bun.file(configTomlPath);
  const existingToml = (await configFile.exists())
    ? await configFile.text()
    : null;
  await writeText(
    configTomlPath,
    spliceManagedConfig(
      existingToml,
      renderConfigToml({
        serverUrl: opts.serverUrl,
        userMemoryDb,
        cartographerBinary,
        apiKey: opts.apiKey,
        selfPath,
      }),
    ),
  );
  await writeExecutable(wrapperPath, wrapperTemplate);
  await writeExecutable(acpWrapperPath, acpWrapperTemplate);
  // Self-updater — the wrapper runs this from ~/.mimir on every launch, so it
  // must not depend on any checkout still being present. Identical content to
  // what the cc installer writes (single canonical script, flavor argument).
  await writeExecutable(join(home, "ensure-binary.sh"), ensureBinaryScript);

  // Shared runtime config (~/.mimir/config.json) — the same file every
  // distribution writes. MERGE over the existing config rather than
  // replacing it: another distribution's fields that this installer
  // doesn't know about (e.g. the extraction trio a cc install recorded)
  // must survive a codex install.
  const existingConfig = await readConfig();
  await writeConfig({
    ...(existingConfig ?? {}),
    serverUrl: opts.serverUrl.replace(/\/+$/, ""),
    userMemoryDb,
    ...(cartographerBinary ? { cartographerBinary } : {}),
    ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
    ...(opts.providerApiKey ? { providerApiKey: opts.providerApiKey } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.smallModel ? { smallModel: opts.smallModel } : {}),
    ...(opts.extractionBaseUrl
      ? { extractionBaseUrl: opts.extractionBaseUrl }
      : {}),
    ...(opts.extractionModel ? { extractionModel: opts.extractionModel } : {}),
  });

  // Embedder artifacts (pinned llama.cpp release + hash-verified GGUF,
  // ~640MB on first run). A failure fails the WHOLE install — no silent
  // text-only installs; re-run once the network/mirror recovers.
  const embedderErr = await installEmbedderArtifacts(log);
  if (embedderErr) {
    return err(`Embedder install failed: ${embedderErr.message}`);
  }

  // Hook trust ledger — Codex silently skips untrusted hooks, so an
  // install without this step looks healthy and does nothing. Codex
  // being unreachable degrades to a loud warning: the artifacts are in
  // place and a re-run of install/update completes the ceremony.
  const trust = await trustMimirHooks(codexHome);
  if (trust.error) {
    log(`WARNING: hook trust failed (${trust.error}) — hooks will not run.`);
    log(`         Re-run 'mimir-codex-bin update' with codex on PATH.`);
  } else {
    log(`Trusted ${trust.trusted} hooks via codex app-server.`);
  }

  const selfResult = await installSelfBinary(selfPath);
  if (!selfResult.ok) return selfResult;

  return ok({
    home,
    codexHome,
    binDir,
    version: promptResult.value.version,
    hooksTrusted: trust.error ? 0 : trust.trusted,
    cartographerBinary,
  });
};

/**
 * CLI entry point — called from install-cli.ts. Prints user-facing
 * output and translates Result into a process exit code.
 */
export const runInstallCommand = async (opts: InstallOptions) => {
  if (!opts.serverUrl) {
    console.error(
      "Usage: mimir-codex-bin install <mimir-server-url> [--user-memory-db PATH] [--cartographer PATH]\n" +
        "  e.g. mimir-codex-bin install https://mimir.example.com",
    );
    return 1;
  }

  const result = await runInstall(opts, (msg) => console.log(`  ${msg}`));
  if (!result.ok) {
    console.error(`Install failed: ${result.error}`);
    return 1;
  }

  const { codexHome, binDir, version, hooksTrusted, cartographerBinary } =
    result.value;
  const carto = cartographerBinary
    ? `  Cartographer:   ${cartographerBinary}`
    : `  Cartographer:   (not configured — auto-reindex disabled)`;

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
      `Mimir for Codex installed.`,
      ``,
      `  Persona:        ${codexHome}/AGENTS.md  (version ${version})`,
      `  Codex config:   ${codexHome}/config.toml  (${hooksTrusted} hooks trusted)`,
      `  Runtime config: ${mimirHome()}/config.json`,
      `  User memories:  ${opts.userMemoryDb ?? join(mimirHome(), "user-memories.db")}`,
      `  Embedder:       ${embedderDir()}  (llama.cpp + pinned GGUF)`,
      carto,
      extractionLine,
      `  Wrapper:        ${binDir}/mimir-codex`,
      `  ACP wrapper:    ${binDir}/mimir-codex-acp`,
      `  Binary:         ${binDir}/mimir-codex-bin`,
      `  Updater:        ${mimirHome()}/ensure-binary.sh`,
      `  Logs:           ${mimirHome()}/logs/mimir-codex.log`,
      ``,
      `Make sure ${binDir} is on your PATH, then run`,
      `  mimir-codex`,
      `to start a Mimir session in Codex.`,
    ].join("\n"),
  );
  return 0;
};
