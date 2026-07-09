/**
 * Editor-agnostic sync command + boot-reconcile helper (MIM-88) — same
 * discipline as keys/cli.ts: the logic lives here once, each
 * distribution wires a thin argv entry (mimir-cc `sync`, mimir-acp
 * pre-handshake dispatch, the oc wrapper branch).
 *
 * Config resolution: env wins, then the shared ~/.mimir/config.json.
 * Unlike the key ceremonies, sync works WITHOUT an apiKey — a keyless
 * server is the self-hosted ungated mode and syncs plaintext envelopes
 * (§9). Only serverUrl is required.
 */

import { join } from "node:path";

import { backfillEmbeddings } from "../brain/backfill";
import { attempt } from "../result";
import { createOrgReplica, defaultOrgReplicaPath } from "../store/org-replica";
import { mimirHome, parseJSON } from "../util";
import { syncOrg } from "./engine";

/** Env-wins config: serverUrl required; apiKey optional (keyless =
 *  plaintext self-hosted); replica path from the MIM-84 convention. */
export async function resolveSyncConfig() {
  const file = Bun.file(join(mimirHome(), "config.json"));
  const [readError, parsed] = await attempt(async () =>
    (await file.exists())
      ? parseJSON<{ serverUrl?: string; apiKey?: string }>(await file.text())
      : null,
  );
  const config = readError ? null : parsed;
  const serverUrl = process.env.MIMIR_SERVER_URL ?? config?.serverUrl;
  if (!serverUrl) {
    return {
      error: "no server URL — install Mimir first (or set MIMIR_SERVER_URL)",
    } as const;
  }
  const apiKey = process.env.MIMIR_API_KEY ?? config?.apiKey;
  const replicaPath =
    process.env.MIMIR_ORG_REPLICA_DB ?? defaultOrgReplicaPath();
  return { serverUrl, apiKey, replicaPath } as const;
}

/**
 * Boot-reconcile helper for the three plugins: silent pull+push, no
 * embedder spawn (pulled rows stay FTS-searchable until the next manual
 * sync or embed-backfill vectorizes them — a boot hook must not wait on
 * a cold llama-server). Never throws.
 */
export async function syncFromSharedConfig() {
  const resolved = await resolveSyncConfig();
  if ("error" in resolved) {
    return { status: "skipped", detail: resolved.error } as const;
  }
  const replica = createOrgReplica(resolved.replicaPath);
  const [error, result] = await attempt(() =>
    syncOrg({
      serverUrl: resolved.serverUrl,
      ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
      replica,
    }),
  );
  replica.close();
  if (error) return { status: "error", detail: error.message } as const;
  return result;
}

/** `mimir sync` — the manual leg: full sync INCLUDING the patient
 *  embedder backfill so pulled rows get vectors and edges. */
export async function runSyncCommand() {
  const resolved = await resolveSyncConfig();
  if ("error" in resolved) {
    console.error(resolved.error);
    return 1;
  }
  const replica = createOrgReplica(resolved.replicaPath);
  const [error, result] = await attempt(() =>
    syncOrg({
      serverUrl: resolved.serverUrl,
      ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
      replica,
      backfill: async (target) => backfillEmbeddings(target, () => {}),
    }),
  );
  replica.close();
  if (error) {
    console.error(`sync failed: ${error.message}`);
    return 1;
  }
  switch (result.status) {
    case "synced": {
      console.log(
        `Synced (${result.mode === "keyring" ? "encrypted" : "plaintext"}): pulled ${result.pulled}, applied ${result.applied}, pushed ${result.pushed}.`,
      );
      if (result.stale.length > 0) {
        console.log(
          `${result.stale.length} local change(s) were stale — a newer version exists; the next sync reconciles.`,
        );
      }
      for (const failure of result.openFailures) {
        console.error(`envelope skipped: ${failure}`);
      }
      return result.openFailures.length > 0 ? 1 : 0;
    }
    case "keys-not-ready":
      console.error(
        `Cannot sync: org keys are ${result.detail} — run \`mimir keys setup\` (or \`mimir keys adopt\`).`,
      );
      return 1;
    case "error":
      console.error(`sync failed: ${result.detail}`);
      return 1;
  }
}
