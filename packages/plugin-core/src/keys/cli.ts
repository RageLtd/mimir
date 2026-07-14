/**
 * Editor-agnostic key-ceremony CLI (MIM-87). The logic lives here ONCE;
 * each distribution wires a thin argv entry to it (mimir-cc `keys`
 * subcommand, mimir-acp pre-handshake dispatch, the oc wrapper's `keys`
 * branch). Hard rule from Rage: a user may not use Claude Code at all —
 * no human key flow may be captive to one editor plugin.
 *
 * Config resolution: env wins, then the shared ~/.mimir/config.json both
 * the cc and oc installers write ({serverUrl, apiKey}).
 *
 * Secrets printed here (device secret at generation, recovery private
 * key at setup) are shown EXACTLY ONCE by design — the 1P Emergency-Kit
 * moment. They are never logged or persisted outside the OS keychain.
 */

import { join } from "node:path";

import { attempt } from "../result";
import { mimirHome, parseJSON } from "../util";
import { fetchOrgKeyState, type KeysClientConfig } from "./client";
import {
  adoptDeviceSecret,
  ensureOrgKey,
  getOrgKeyring,
  reconcileKeys,
  recoverAccess,
  registerKeys,
  resolveKeyset,
  rotateOrgKey,
  setupRecovery,
} from "./flows";

const USAGE = [
  "Usage: mimir keys <command>",
  "",
  "Commands:",
  "  status          Key state for your account and org.",
  "  setup           First-time ceremony: device secret + keyset +",
  "                  org key. Prints the device secret ONCE — store it",
  "                  in your password manager. (alias: init)",
  "  adopt [secret]  Bring a new device online with the device secret",
  "                  from your password manager.",
  "  rotate          Rotate the org key (run AFTER removing a member —",
  "                  everyone not re-wrapped loses access).",
  "  recovery-setup  Create the org recovery keyset. Prints the recovery",
  "                  private key ONCE — store it offline.",
  "  recover [key]   Re-enter the org with the recovery private key",
  "                  after losing the device secret.",
].join("\n");

/** Env wins over the shared config file — same discipline as every
 *  other Mimir credential chain. */
export async function resolveKeysConfig() {
  const file = Bun.file(join(mimirHome(), "config.json"));
  const [readError, parsed] = await attempt(async () =>
    (await file.exists())
      ? parseJSON<{ serverUrl?: string; apiKey?: string }>(await file.text())
      : null,
  );
  const config = readError ? null : parsed;
  const serverUrl = process.env.MIMIR_SERVER_URL ?? config?.serverUrl;
  const apiKey = process.env.MIMIR_API_KEY ?? config?.apiKey;
  if (!serverUrl) {
    return {
      error: "no server URL — install Mimir first (or set MIMIR_SERVER_URL)",
    } as const;
  }
  if (!apiKey) {
    return {
      error:
        "no API key — key ceremonies need an authenticated server (set MIMIR_API_KEY or reinstall with --api-key)",
    } as const;
  }
  return { cfg: { serverUrl, apiKey } } as const;
}

/**
 * Boot-reconcile convenience for the three plugins: resolve the shared
 * config and run the silent reconcile. Skips when no serverUrl/apiKey is
 * configured — ungated self-hosted setups have no key ceremony. Never
 * throws; callers log the status and move on.
 */
export async function reconcileFromSharedConfig() {
  const resolved = await resolveKeysConfig();
  if ("error" in resolved) {
    return { status: "skipped", detail: resolved.error } as const;
  }
  return reconcileKeys(resolved.cfg);
}

const SECRET_BANNER = [
  "",
  "  ┌─ DEVICE SECRET — shown once, store it NOW ─────────────────┐",
  "  │ Save this in your password manager. It is the only way to  │",
  "  │ bring a new device online or survive a lost keychain.      │",
  "  └─────────────────────────────────────────────────────────────┘",
].join("\n");

const printDeviceSecret = (secret: string) => {
  console.log(SECRET_BANNER);
  console.log(`\n  ${secret}\n`);
};

const readSecretArg = (arg: string | undefined, promptText: string) => {
  if (arg) return arg;
  // Bun provides the browser-style prompt() on a TTY; null otherwise.
  const entered = prompt(promptText);
  return entered ?? undefined;
};

async function runStatus(cfg: KeysClientConfig) {
  const state = await fetchOrgKeyState(cfg);
  const resolved = await resolveKeyset(cfg, state);
  const lines: string[] = [];
  lines.push(
    `org key:     ${state.initialized ? `generation ${state.keyGeneration}` : "not initialized"}`,
  );
  lines.push(`account:     ${resolved.status}`);
  lines.push(
    `this device: ${resolved.status === "ready" ? "unlocked" : resolved.status === "needs-secret" ? "no device secret — run `mimir keys adopt`" : "—"}`,
  );
  lines.push(
    `recovery:    ${state.recoveryPublicKey ? "configured" : "NOT configured — `mimir keys recovery-setup` is recommended"}`,
  );
  const pending = state.members.filter((m) => m.publicKey && !m.hasWrap);
  lines.push(
    `members:     ${state.members.length} (${pending.length} awaiting a key wrap)`,
  );
  for (const member of pending) {
    lines.push(`  pending: ${member.email}`);
  }
  console.log(lines.join("\n"));
  return 0;
}

async function runSetup(cfg: KeysClientConfig) {
  const resolved = await resolveKeyset(cfg);
  if (resolved.status === "needs-secret") {
    console.error(
      "This account already has a keyset — bring this device online with `mimir keys adopt` instead.",
    );
    return 1;
  }
  if (resolved.status === "needs-recovery") {
    console.error(
      `Your keyset is unreadable (${resolved.detail ?? "unknown"}) — use \`mimir keys recover\`.`,
    );
    return 1;
  }
  let keyset = resolved.status === "ready" ? resolved.keyset : null;
  if (!keyset) {
    const registered = await registerKeys(cfg);
    keyset = registered.keyset;
    console.log("Keyset generated and registered.");
    if (registered.secretCreated) printDeviceSecret(registered.deviceSecret);
  } else {
    console.log("Keyset already registered and unlocked on this device.");
  }
  const org = await ensureOrgKey(cfg, keyset);
  if (org.status === "ready") {
    console.log("Org key ready.");
  } else {
    console.log(
      "Waiting for an existing org member to come online and share the org key with you.",
    );
  }
  return 0;
}

async function runAdopt(cfg: KeysClientConfig, arg: string | undefined) {
  const secret = readSecretArg(
    arg,
    "Device secret from your password manager:",
  );
  if (!secret) {
    console.error("No secret provided.");
    return 1;
  }
  await adoptDeviceSecret(cfg, secret);
  console.log(
    "Device secret adopted — this device can now unlock your keyset.",
  );
  const ready = await getOrgKeyring(cfg);
  console.log(
    ready.status === "ready"
      ? `Org key ready (generation ${ready.generation}).`
      : `Org key: ${ready.status}.`,
  );
  return 0;
}

async function runRotate(cfg: KeysClientConfig) {
  const resolved = await resolveKeyset(cfg);
  if (resolved.status !== "ready") {
    console.error(`Cannot rotate: account state is ${resolved.status}.`);
    return 1;
  }
  const rotated = await rotateOrgKey(cfg, resolved.keyset);
  console.log(
    `Org key rotated to generation ${rotated.generation}; ${rotated.wrapped} member(s) re-wrapped.`,
  );
  console.log(
    "Current keyed members now hold the new key. Synced data re-encrypts under the new generation as it is pushed.",
  );
  return 0;
}

async function runRecoverySetup(cfg: KeysClientConfig) {
  const resolved = await resolveKeyset(cfg);
  if (resolved.status !== "ready") {
    console.error(
      `Cannot configure recovery: account state is ${resolved.status}.`,
    );
    return 1;
  }
  const recovery = await setupRecovery(cfg, resolved.keyset);
  console.log(
    [
      "",
      "  ┌─ RECOVERY KEY — shown once, store it OFFLINE ──────────────┐",
      "  │ Anyone holding this key can decrypt the org store. Print   │",
      "  │ it or keep it in a vault; do NOT leave it on this machine. │",
      "  └─────────────────────────────────────────────────────────────┘",
      "",
      `  ${recovery.recoveryPrivateKey}`,
      "",
    ].join("\n"),
  );
  return 0;
}

async function runRecover(cfg: KeysClientConfig, arg: string | undefined) {
  const key = readSecretArg(arg, "Org recovery private key:");
  if (!key) {
    console.error("No recovery key provided.");
    return 1;
  }
  const recovered = await recoverAccess(cfg, key);
  console.log(
    "Access recovered — new keyset registered and org key re-wrapped.",
  );
  if (recovered.secretCreated) printDeviceSecret(recovered.deviceSecret);
  return 0;
}

/** Entry point every distribution dispatches to. Returns an exit code. */
export async function runKeysCommand(argv: readonly string[]) {
  const [command, arg] = argv;
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return command ? 0 : 1;
  }
  const resolvedConfig = await resolveKeysConfig();
  if ("error" in resolvedConfig) {
    console.error(resolvedConfig.error);
    return 1;
  }
  const { cfg } = resolvedConfig;
  const [error, code] = await attempt(async () => {
    switch (command) {
      case "status":
        return runStatus(cfg);
      case "setup":
      case "init":
        return runSetup(cfg);
      case "adopt":
        return runAdopt(cfg, arg);
      case "rotate":
        return runRotate(cfg);
      case "recovery-setup":
        return runRecoverySetup(cfg);
      case "recover":
        return runRecover(cfg, arg);
      default:
        console.error(`Unknown keys command: ${command}\n\n${USAGE}`);
        return 1;
    }
  });
  if (error) {
    console.error(`keys ${command} failed: ${error.message}`);
    return 1;
  }
  return code;
}
