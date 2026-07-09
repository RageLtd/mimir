/**
 * Device-secret provider (MIM-87, THREAT_MODEL §5) — the 1Password
 * Secret-Key analog. A 32-byte secret held in the OS credential store
 * via `Bun.secrets` (macOS Keychain Services, Linux libsecret, Windows
 * Credential Manager), with a password-manager copy prompted at
 * generation as the recovery artifact. The secret derives the key that
 * decrypts the server-held encrypted keyset (keyset.ts).
 *
 * `Bun.secrets` is experimental, so every touch goes through this seam
 * (API-churn containment). The seam also hosts the fallback for
 * keychain-less environments (headless Linux without a secret-service
 * daemon): a passphrase-encrypted file at ~/.mimir/device-secret.enc,
 * scrypt → AES-256-GCM, passphrase from MIMIR_KEY_PASSPHRASE.
 *
 * macOS note (install story): keychain ACLs bind to the `bun` binary —
 * one grant covers all hook processes; a Bun upgrade re-prompts once.
 *
 * Error contract: throws with specific messages; flow-level callers
 * convert with attempt/attemptSync.
 */

import { randomBytes, scryptSync } from "node:crypto";
import { join } from "node:path";
import { attempt } from "../result";
import { mimirHome, parseJSON } from "../util";
import { aesGcmOpen, aesGcmSeal, fromB64u, toB64u } from "./crypto";

/** Keychain service every Mimir device secret lives under. */
const SECRETS_SERVICE = "mimir";
const SECRET_BYTES = 32;
const SCRYPT_SALT_BYTES = 16;
const FALLBACK_FILE = "device-secret.enc";
const FALLBACK_VERSION = 1;
export const PASSPHRASE_ENV = "MIMIR_KEY_PASSPHRASE";

/** Storage seam — Bun.secrets in production, injectable for tests (which
 *  must never touch the developer's real keychain). */
export type SecretStore = {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
};

/** Secrets are per server host: one developer may hold accounts on
 *  several mimir servers, each with its own keyset. */
export function secretName(serverUrl: string) {
  const parsed = new URL(serverUrl);
  return `device-secret:${parsed.host}`;
}

export const generateDeviceSecret = () => toB64u(randomBytes(SECRET_BYTES));

const assertSecretShape = (secret: string) => {
  if (fromB64u(secret).length !== SECRET_BYTES) {
    throw new Error("device secret must be 32 bytes base64url");
  }
};

const bunSecretsStore: SecretStore = {
  get: (name) => Bun.secrets.get({ service: SECRETS_SERVICE, name }),
  set: async (name, value) => {
    await Bun.secrets.set({ service: SECRETS_SERVICE, name, value });
  },
};

/** Fallback file shape: per-entry scrypt salt, AES-256-GCM sealed value. */
type FallbackFile = {
  v: typeof FALLBACK_VERSION;
  entries: Record<string, { salt: string; ct: string }>;
};

const emptyFallback = () => {
  // Variable annotation (not a return annotation) keeps the empty
  // entries literal indexable as a Record instead of the `{}` type.
  const empty: FallbackFile = { v: FALLBACK_VERSION, entries: {} };
  return empty;
};

const fallbackKey = (passphrase: string, salt: Uint8Array) =>
  scryptSync(passphrase, salt, SECRET_BYTES);

/**
 * Passphrase-encrypted-file store for keychain-less environments. The
 * path parameter exists for tests; production uses ~/.mimir.
 */
export function fileSecretStore(
  passphrase: string,
  filePath = join(mimirHome(), FALLBACK_FILE),
) {
  if (!passphrase) {
    throw new Error("empty passphrase for device-secret file store");
  }
  const read = async () => {
    const file = Bun.file(filePath);
    if (!(await file.exists())) return emptyFallback();
    const parsed = parseJSON<FallbackFile>(await file.text());
    if (parsed.v !== FALLBACK_VERSION || typeof parsed.entries !== "object") {
      throw new Error(`unrecognized device-secret file at ${filePath}`);
    }
    return parsed;
  };
  return {
    get: async (name) => {
      const store = await read();
      const entry = store.entries[name];
      if (!entry) return null;
      const key = fallbackKey(passphrase, fromB64u(entry.salt));
      return aesGcmOpen(key, fromB64u(entry.ct)).toString("utf8");
    },
    set: async (name, value) => {
      const store = await read();
      const salt = randomBytes(SCRYPT_SALT_BYTES);
      const key = fallbackKey(passphrase, salt);
      store.entries[name] = {
        salt: toB64u(salt),
        ct: toB64u(aesGcmSeal(key, Buffer.from(value, "utf8"))),
      };
      await Bun.write(filePath, `${JSON.stringify(store)}\n`);
    },
  } satisfies SecretStore;
}

const passphraseFallback = () => {
  const passphrase = process.env[PASSPHRASE_ENV];
  return passphrase ? fileSecretStore(passphrase) : null;
};

const getOrCreate = async (store: SecretStore, name: string) => {
  const existing = await store.get(name);
  if (existing) {
    assertSecretShape(existing);
    return { secret: existing, created: false };
  }
  const secret = generateDeviceSecret();
  await store.set(name, secret);
  return { secret, created: true };
};

/**
 * Get-or-generate the device secret for a server. `created: true` means
 * the caller MUST surface the persist-to-password-manager prompt — the
 * secret is shown exactly once at generation (1P Emergency Kit parity).
 *
 * Store resolution: injected store (tests) → OS keychain → passphrase
 * file when the keychain layer throws (no secret-service daemon) and
 * MIMIR_KEY_PASSPHRASE is set. A missing SECRET is not an error (it
 * generates); an unusable KEYCHAIN without a configured fallback is.
 */
export async function ensureDeviceSecret(
  serverUrl: string,
  store?: SecretStore,
) {
  const name = secretName(serverUrl);
  if (store) return getOrCreate(store, name);
  const [keychainError, result] = await attempt(() =>
    getOrCreate(bunSecretsStore, name),
  );
  if (!keychainError) return result;
  const fallback = passphraseFallback();
  if (!fallback) {
    throw new Error(
      `OS keychain unavailable (${keychainError.message}) and ${PASSPHRASE_ENV} is not set — set it to use the encrypted-file fallback`,
    );
  }
  return getOrCreate(fallback, name);
}

/** Read-only lookup — null when no secret exists on this device (the
 *  new-device flow prompts for the password-manager copy instead of
 *  minting a fresh one that could not decrypt the server-held keyset). */
export async function getDeviceSecret(serverUrl: string, store?: SecretStore) {
  const name = secretName(serverUrl);
  if (store) return store.get(name);
  const [keychainError, value] = await attempt(() => bunSecretsStore.get(name));
  if (!keychainError) return value;
  const fallback = passphraseFallback();
  if (!fallback) {
    throw new Error(
      `OS keychain unavailable (${keychainError.message}) and ${PASSPHRASE_ENV} is not set — set it to use the encrypted-file fallback`,
    );
  }
  return fallback.get(name);
}

/** Persist a user-supplied secret (new-device flow: pasted from the
 *  password manager) after shape validation. */
export async function storeDeviceSecret(
  serverUrl: string,
  secret: string,
  store?: SecretStore,
) {
  assertSecretShape(secret);
  const name = secretName(serverUrl);
  if (store) return store.set(name, secret);
  const [keychainError] = await attempt(() =>
    bunSecretsStore.set(name, secret),
  );
  if (!keychainError) return;
  const fallback = passphraseFallback();
  if (!fallback) {
    throw new Error(
      `OS keychain unavailable (${keychainError.message}) and ${PASSPHRASE_ENV} is not set — set it to use the encrypted-file fallback`,
    );
  }
  return fallback.set(name, secret);
}
