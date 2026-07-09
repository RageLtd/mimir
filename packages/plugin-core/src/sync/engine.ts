/**
 * Client sync engine (MIM-88): pull → apply (LWW) → re-embed →
 * re-derive edges → push. The only caller of the envelope seam; the
 * replica above it never sees ciphertext, the wire below it never sees
 * plaintext (cloud mode).
 *
 * Mode resolution (§9, decided once per run):
 *  - no apiKey configured → self-hosted ungated server → plaintext
 *    envelopes (suite 0x00), no key ceremony;
 *  - apiKey + org keyring ready (MIM-87) → AES-256-GCM envelopes;
 *  - apiKey but keys not ready → sync SKIPS and reports the owed
 *    ceremony. An authed org never silently falls back to plaintext.
 *
 * Client cursor is keyed by server host: one org per server is the
 * alpha assumption (a second org means a second replica file anyway).
 *
 * Never throws — Result-shaped like reconcileKeys; boot paths log the
 * status and move on.
 */

import type { Fetcher } from "../keys/client";
import type { SecretStore } from "../keys/device-secret";
import { getOrgKeyring } from "../keys/flows";
import { attempt } from "../result";
import type { OrgReplica } from "../store/org-replica";
import type { RemoteMemory } from "../store/org-replica-sync";
import { parseJSON } from "../util";
import {
  type EnvelopeCipher,
  KIND_MEMORY,
  KIND_PLAYBOOK,
  openEnvelope,
  sealEnvelope,
  type WireEnvelope,
} from "./envelope";

const PULL_PAGE_LIMIT = 500;
const MAX_PULL_PAGES = 40;

export type SyncEngineConfig = {
  readonly serverUrl: string;
  /** Absent → ungated self-hosted server → plaintext suite. */
  readonly apiKey?: string;
  readonly fetcher?: Fetcher;
  readonly store?: SecretStore;
  readonly replica: OrgReplica;
  /** Re-embed pulled rows when an embedder is reachable. Injectable so
   *  tests (and embedder-less hosts) skip the network. */
  readonly backfill?: (replica: OrgReplica) => Promise<unknown>;
};

type PullResponse = {
  orgId: string;
  envelopes: WireEnvelope[];
  nextCursor: number;
};

const request = async (
  cfg: SyncEngineConfig,
  path: string,
  init?: { method?: string; body?: unknown },
) => {
  const fetcher = cfg.fetcher ?? fetch;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (cfg.apiKey) {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
    headers["x-api-key"] = cfg.apiKey;
  }
  const response = await fetcher(
    `${cfg.serverUrl.replace(/\/+$/, "")}${path}`,
    {
      method: init?.method ?? "GET",
      headers,
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${path} failed: HTTP ${response.status}`);
  }
  return text;
};

/** Payload carried inside memory/playbook envelopes — the replica row
 *  minus embedding and local usage noise. */
const payloadFor = (row: {
  content: string;
  project_id: string | null;
  type: string;
  name: string | null;
  trigger: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
}) =>
  JSON.stringify({
    content: row.content,
    project_id: row.project_id,
    type: row.type,
    name: row.name,
    trigger: row.trigger,
    confidence: row.confidence,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });

const toRemoteMemory = (opened: {
  id: string;
  version: number;
  tombstone: boolean;
  payload: string | null;
}) => {
  if (opened.tombstone || opened.payload === null) {
    return {
      id: opened.id,
      version: opened.version,
      tombstone: true,
      content: "",
      project_id: null,
      type: "fact",
      name: null,
      trigger: null,
      confidence: 1,
      created_at: "",
      updated_at: "",
    } satisfies RemoteMemory;
  }
  const payload = parseJSON<Omit<RemoteMemory, "id" | "version" | "tombstone">>(
    opened.payload,
  );
  return {
    id: opened.id,
    version: opened.version,
    tombstone: false,
    ...payload,
  } satisfies RemoteMemory;
};

/** Resolve the cipher mode for this run — see module docs. */
async function resolveCipher(cfg: SyncEngineConfig) {
  if (!cfg.apiKey) {
    return { cipher: { mode: "plaintext" } satisfies EnvelopeCipher } as const;
  }
  const keys = await getOrgKeyring({
    serverUrl: cfg.serverUrl,
    apiKey: cfg.apiKey,
    ...(cfg.fetcher ? { fetcher: cfg.fetcher } : {}),
    ...(cfg.store ? { store: cfg.store } : {}),
  });
  if (keys.status !== "ready") {
    return { blocked: keys.status } as const;
  }
  return {
    cipher: {
      mode: "keyring",
      keyring: keys.keyring,
    } satisfies EnvelopeCipher,
  } as const;
}

/** Derive relates_to edges for freshly applied rows once the backfill
 *  has embedded them — the storeTyped neighbor-linking pattern. */
const deriveEdges = (replica: OrgReplica, ids: string[]) => {
  for (const id of ids) {
    const embedding = replica.getEmbedding(id);
    if (!embedding) continue;
    for (const neighbor of replica.findNeighbors(embedding, id)) {
      replica.createRelation(
        id,
        neighbor.id,
        Math.max(0, 1 - neighbor.distance),
      );
    }
  }
};

export async function syncOrg(cfg: SyncEngineConfig) {
  const mode = await resolveCipher(cfg);
  if ("blocked" in mode) {
    return { status: "keys-not-ready", detail: mode.blocked } as const;
  }
  const { cipher } = mode;
  const cursorKey = new URL(cfg.serverUrl).host;

  // ── Pull ────────────────────────────────────────────────────────────
  let cursor = cfg.replica.getSyncCursor(cursorKey);
  let orgId = "";
  let pulled = 0;
  let applied = 0;
  const failures: string[] = [];
  const appliedIds: string[] = [];
  for (let page = 0; page < MAX_PULL_PAGES; page++) {
    const [pullError, raw] = await attempt(() =>
      request(cfg, `/v1/sync/pull?since=${cursor}&limit=${PULL_PAGE_LIMIT}`),
    );
    if (pullError) {
      return { status: "error", detail: pullError.message } as const;
    }
    const response = parseJSON<PullResponse>(raw);
    orgId = response.orgId;
    pulled += response.envelopes.length;
    for (const envelope of response.envelopes) {
      const [openError, record] = await attempt(async () =>
        toRemoteMemory(openEnvelope(envelope, { orgId, cipher })),
      );
      if (openError) {
        // Tampered, transplanted, or from a generation this client lacks
        // — skipped loudly, never applied blind.
        failures.push(`${envelope.id}: ${openError.message}`);
        continue;
      }
      const result = cfg.replica.applyRemote(record);
      if (result.applied) {
        applied += 1;
        if (!record.tombstone) appliedIds.push(record.id);
      }
    }
    cursor = response.nextCursor;
    if (response.envelopes.length < PULL_PAGE_LIMIT) break;
  }
  cfg.replica.setSyncCursor(cursorKey, cursor);

  // ── Re-embed + edges (best effort; FTS covers rows until then) ─────
  if (appliedIds.length > 0 && cfg.backfill) {
    const [embedError] = await attempt(() =>
      Promise.resolve(cfg.backfill?.(cfg.replica)),
    );
    if (!embedError) deriveEdges(cfg.replica, appliedIds);
  }

  // ── Push ────────────────────────────────────────────────────────────
  const dirty = cfg.replica.listDirty();
  let pushedIds: string[] = [];
  let stale: string[] = [];
  if (dirty.length > 0) {
    const envelopes = dirty.map((row) =>
      sealEnvelope({
        id: row.id,
        orgId,
        kind: row.type === "playbook" ? KIND_PLAYBOOK : KIND_MEMORY,
        version: row.version,
        tombstone: row.tombstone === 1,
        payload: payloadFor(row),
        cipher,
      }),
    );
    const [pushError, pushRaw] = await attempt(() =>
      request(cfg, "/v1/sync/push", { method: "POST", body: { envelopes } }),
    );
    if (pushError) {
      return {
        status: "error",
        detail: pushError.message,
        pulled,
        applied,
      } as const;
    }
    const pushResponse = parseJSON<{ accepted: number; stale: string[] }>(
      pushRaw,
    );
    stale = pushResponse.stale;
    const staleSet = new Set(stale);
    pushedIds = dirty.map((r) => r.id).filter((id) => !staleSet.has(id));
    cfg.replica.markPushed(pushedIds);
  }

  return {
    status: "synced",
    mode: cipher.mode,
    pulled,
    applied,
    pushed: pushedIds.length,
    stale,
    openFailures: failures,
  } as const;
}
