/**
 * `mimir-codex-bin status` — one-command visibility into the failure
 * modes that are otherwise silent:
 *
 *   - per-hook trustStatus (a hand-edited hook line changes its identity
 *     hash and Codex silently stops running it — nothing else surfaces
 *     that),
 *   - extraction configuration (unconfigured = memory distillation OFF,
 *     previously visible only as a per-turn log warning),
 *   - the shared runtime config's key facts.
 *
 * Read-only; never mutates trust. `mimir-codex-bin update` is the
 * remedy for anything untrusted.
 */

import { extractionConfig, readConfig } from "@mimir/plugin-core/shared-config";
import { mimirCodexHome } from "./paths";
import { listHooks } from "./trust";

const TRUSTED = "trusted";

export const runStatusCommand = async () => {
  const config = await readConfig();
  if (!config) {
    console.error(
      "No ~/.mimir/config.json — run `mimir-codex-bin install <server-url>` first.",
    );
    return 1;
  }

  console.log(`Server:        ${config.serverUrl}`);
  console.log(`Codex home:    ${mimirCodexHome()}`);
  console.log(
    `Cartographer:  ${config.cartographerBinary ?? "(not configured — code indexing disabled)"}`,
  );

  const extraction = await extractionConfig();
  console.log(
    extraction
      ? `Extraction:    ${extraction.model} via ${extraction.baseUrl}`
      : "Extraction:    NOT CONFIGURED — memory distillation is OFF.",
  );

  const listed = await listHooks(mimirCodexHome(), process.cwd());
  if ("error" in listed) {
    console.error(
      `\nHooks: could not query codex app-server — ${listed.error}`,
    );
    return 1;
  }

  const mimirHooks = listed.hooks.filter((hook) => hook.isManaged === false);
  if (mimirHooks.length === 0) {
    console.error(
      "\nHooks: none discovered — re-run `mimir-codex-bin update`.",
    );
    return 1;
  }

  console.log("\nHooks:");
  let untrusted = 0;
  for (const hook of mimirHooks) {
    const trust = hook.trustStatus ?? "unknown";
    if (trust !== TRUSTED) untrusted++;
    const marker = trust === TRUSTED ? "✓" : "✗";
    // Key format: <sourcePath>:<event>:<group>:<hook> — the tail is the
    // readable identity; the command names the mimir subcommand.
    const event = hook.key?.split(":").slice(-3).join(":") ?? "?";
    console.log(`  ${marker} ${event}  ${trust}`);
  }

  if (untrusted > 0) {
    console.log(
      `\n${untrusted} hook(s) not trusted — they are SILENTLY SKIPPED by codex.` +
        `\nRun \`mimir-codex-bin update\` to re-render and re-trust.`,
    );
    return 1;
  }

  console.log(`\nAll ${mimirHooks.length} hooks trusted.`);
  return 0;
};
