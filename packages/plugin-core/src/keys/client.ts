/**
 * HTTP layer for the key-distribution flows (MIM-87): the /v1/keys
 * routes plus better-auth's update-user (publicKey/encryptedKeyset
 * registration). Editor-agnostic — callers supply {serverUrl, apiKey}
 * from their own config chain; the fetcher is injectable for tests.
 *
 * Error contract: throws on transport failures and non-OK statuses
 * (message carries the status code so flows can branch on 409 races);
 * flow-level callers convert with attempt().
 */

import { parseJSON } from "../util";

/** Plain function shape (not `typeof fetch`) — Bun's fetch carries static
 *  properties that would make injected test fakes unassignable. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type KeysClientConfig = {
  readonly serverUrl: string;
  readonly apiKey: string;
  readonly fetcher?: Fetcher;
};

export type OrgKeyMember = {
  memberId: string;
  userId: string;
  email: string;
  publicKey: string | null;
  hasWrap: boolean;
};

export type OrgKeyState = {
  initialized: boolean;
  keyGeneration: number | null;
  recoveryPublicKey: string | null;
  wrappedRecoveryKey: string | null;
  self: {
    memberId: string;
    userId: string;
    publicKey: string | null;
    encryptedKeyset: string | null;
    wrappedOrgKey: string | null;
  };
  members: OrgKeyMember[];
};

const trimSlash = (url: string) => url.replace(/\/+$/, "");

const request = async (
  cfg: KeysClientConfig,
  path: string,
  init?: { method?: string; body?: unknown },
) => {
  const fetcher = cfg.fetcher ?? fetch;
  const response = await fetcher(`${trimSlash(cfg.serverUrl)}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      // Both credential headers, same key: the /v1 identity gate maps
      // Bearer → x-api-key itself, but /api/auth/* routes hit better-auth
      // DIRECTLY and its api-key plugin only reads x-api-key natively
      // (found live: update-user 401s on Bearer alone).
      Authorization: `Bearer ${cfg.apiKey}`,
      "x-api-key": cfg.apiKey,
      "content-type": "application/json",
    },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `${path} failed: HTTP ${response.status}${text ? ` — ${text}` : ""}`,
    );
  }
  return text;
};

/** Status-code sniffing for expected races (init/wrap/rotate 409s). */
export const isConflict = (error: Error) => error.message.includes("HTTP 409");

export const fetchOrgKeyState = async (cfg: KeysClientConfig) =>
  parseJSON<OrgKeyState>(await request(cfg, "/v1/keys/org"));

export const postInit = (
  cfg: KeysClientConfig,
  body: {
    wrappedOrgKey: string;
    recoveryPublicKey?: string;
    wrappedRecoveryKey?: string;
  },
) => request(cfg, "/v1/keys/init", { method: "POST", body });

export const postWrap = (
  cfg: KeysClientConfig,
  body: { memberId: string; wrappedOrgKey: string },
) => request(cfg, "/v1/keys/wrap", { method: "POST", body });

export const postRotate = (
  cfg: KeysClientConfig,
  body: {
    keyGeneration: number;
    wraps: Array<{ memberId: string; wrappedOrgKey: string }>;
    recovery?: { recoveryPublicKey: string; wrappedRecoveryKey: string };
  },
) => request(cfg, "/v1/keys/rotate", { method: "POST", body });

export const postRecovery = (
  cfg: KeysClientConfig,
  body: { recoveryPublicKey: string; wrappedRecoveryKey: string },
) => request(cfg, "/v1/keys/recovery", { method: "POST", body });

/** Register/refresh the user's public key + encrypted keyset through
 *  better-auth's own update-user endpoint (input:true additionalFields).
 *  API-key sessions skip better-auth's Origin CSRF check (cookie-only). */
export const updateUserKeys = (
  cfg: KeysClientConfig,
  body: { publicKey: string; encryptedKeyset: string },
) => request(cfg, "/api/auth/update-user", { method: "POST", body });
