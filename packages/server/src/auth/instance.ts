/**
 * Better Auth instance (MIM-70, slice 1).
 *
 * Lazily constructed so an auth-disabled boot (the self-hosted default)
 * never touches the SQLite file. Store is bun:sqlite through better-auth's
 * bundled Kysely — zero external database dependencies; the runtime itself
 * carries the driver. Schema lands via boot-time programmatic migrations
 * (runAuthMigrations), the built-in-Kysely-only path — no CLI step in
 * deploys, same pattern as Surreal's initSchema.
 *
 * Deliberately logger-free: boot-sequence logging belongs to index.ts, and
 * keeping this module free of util/logger avoids the tests/setup.ts
 * preload-mock lockstep.
 */

import { Database } from "bun:sqlite";
import { apiKey } from "@better-auth/api-key";
import { passkey } from "@better-auth/passkey";
import { type BetterAuthOptions, betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { organization } from "better-auth/plugins";
import { config } from "../config";

/**
 * Assemble better-auth options for a given store and secret. Split from
 * getAuth so tests can build an instance against an in-memory database
 * without touching config-driven paths.
 *
 * Plugin set (all first-party, version-locked to better-auth):
 * - organization: multi-tenancy — orgs/members/invitations (MIM-69 scope grain)
 * - apiKey: machine-client auth; enableSessionForAPIKeys turns a valid
 *   x-api-key header into a session so one getSession path serves both
 *   humans and the cc-plugin/ACP clients (slice 2)
 * - passkey: on by default (Rage 2026-07-04) — rpID/rpName derive from
 *   baseURL; WebAuthn ceremonies belong to the dashboard/installer clients
 */
export function buildAuthOptions(database: Database, secret: string) {
  return {
    database,
    secret,
    baseURL: config.auth.baseUrl,
    emailAndPassword: { enabled: true },
    /**
     * MIM-75 key shelf (slice 3): E2E wrapped-key distribution fields,
     * 1Password-modeled. Every value here is CIPHERTEXT the server cannot
     * open — key generation, wrapping, and unwrapping are client-side only.
     * Better Auth is the distribution channel: its endpoints accept and
     * return these fields automatically.
     */
    user: {
      additionalFields: {
        /** User's public key (X25519) — the half the org key gets wrapped
         *  to. Registered by the client at first login. */
        publicKey: { type: "string", required: false, input: true },
        /** MIM-87: the user's keyset (X25519 keypair) encrypted under the
         *  device secret — the 1Password encrypted-keyset analog. Stored
         *  server-side so a new device needs only the password-manager
         *  copy of the device secret. Ciphertext the server cannot open. */
        encryptedKeyset: { type: "string", required: false, input: true },
      },
    },
    plugins: [
      organization({
        schema: {
          organization: {
            additionalFields: {
              /** Recovery keyset public half (1P Recovery Group pattern,
               *  per-org opt-in). */
              recoveryPublicKey: {
                type: "string",
                required: false,
                input: true,
              },
              /** Org data key wrapped to the recovery public key. */
              wrappedRecoveryKey: {
                type: "string",
                required: false,
                input: true,
              },
              /** MIM-87: current org-key generation (metadata, accepted
               *  residual — the operator may observe THAT a rotation
               *  happened). input:false — only the /v1/keys routes write
               *  it, atomically with the member re-wraps. */
              keyGeneration: { type: "number", required: false, input: false },
            },
          },
          member: {
            additionalFields: {
              /** Org data key wrapped to THIS member's publicKey — written
               *  by an existing member's client at invite acceptance. */
              wrappedOrgKey: { type: "string", required: false, input: true },
            },
          },
        },
      }),
      apiKey({
        enableSessionForAPIKeys: true,
        /** better-auth's stock default is 10 requests per DAY — sized for
         *  public SaaS demo keys, lethal for machine clients that hit the
         *  gate on every hook fetch. A fresh session burns 10 requests in
         *  seconds, then every verify rejects and surfaces as the gate's
         *  detail-free 401 (the MIM-70 cutover outage, 2026-07-05).
         *  100/min keeps a real throttle without strangling the
         *  cc-plugin/ACP clients. NOTE: values are stamped onto each key
         *  row at creation — changing them here does not retune existing
         *  keys; re-mint after changing. */
        rateLimit: {
          enabled: true,
          timeWindow: 60_000,
          maxRequests: 100,
        },
      }),
      passkey(),
    ],
    // satisfies (not an annotation): keeps literal inference — "string"
    // stays DBFieldType, plugin types stay concrete so InferAPI exposes
    // the org/api-key/passkey endpoints — while still checking the shape.
  } satisfies BetterAuthOptions;
}

/** Construct the real instance from config — type flows from the concrete
 *  options, not the generic BetterAuthOptions (plugin endpoints/types on
 *  auth.api depend on it). */
function createInstance() {
  store = new Database(config.auth.dbPath, { create: true });
  return betterAuth(buildAuthOptions(store, config.auth.secret));
}

let instance: ReturnType<typeof createInstance> | null = null;
let store: Database | null = null;

/**
 * Direct handle on the auth SQLite store — for the read-only row counts the
 * claim flow needs (user/invitation counts have no better-auth API surface).
 * Writes stay better-auth's exclusive business, with ONE documented
 * exception: routes/keys.ts writes the MIM-87 key-distribution columns
 * (member.wrappedOrgKey, organization.keyGeneration + recovery fields)
 * because better-auth has no endpoint that writes another member's row,
 * and rotation must replace every member's wrap in one transaction.
 */
export function getAuthDb() {
  if (!store) {
    getAuth();
  }
  // getAuth() → createInstance() always assigns store before returning.
  if (!store) {
    throw new Error("auth store failed to initialise");
  }
  return store;
}

/**
 * Get (or lazily create) the singleton auth instance. Callers gate on
 * config.auth.enabled — this module does not check it, so a misplaced call
 * on a disabled deployment fails loudly at the filesystem rather than
 * silently fabricating an unconfigured auth layer.
 */
export function getAuth() {
  if (!instance) {
    instance = createInstance();
  }
  return instance;
}

/**
 * Apply better-auth's schema (core + plugin tables) to the SQLite store.
 * Idempotent — getMigrations diffs against the live schema and produces
 * only the missing pieces. Boot calls this before serving when auth is
 * enabled; failures are fatal there by design.
 */
export async function runAuthMigrations() {
  const { runMigrations } = await getMigrations(getAuth().options);
  await runMigrations();
}
