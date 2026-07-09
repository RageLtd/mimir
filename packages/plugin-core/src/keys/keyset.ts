/**
 * User keyset — the 1Password-keyset analog (MIM-87). Holds the user's
 * X25519 keypair; the encrypted form lives server-side on the user
 * record (`user.encryptedKeyset`), ciphertext the server cannot open.
 * The device secret (OS keychain + password-manager copy) derives the
 * encryption key, so a new device needs only the secret: pull the
 * encrypted keyset, decrypt locally, done.
 */

import {
  aesGcmOpen,
  aesGcmSeal,
  deriveKey,
  fromB64u,
  generateKeypair,
  publicKeyFromPrivate,
  toB64u,
} from "./crypto";

export const KEYSET_VERSION = 1;
/** HKDF domain separation: device secret → keyset-encryption key. */
const KEYSET_INFO = "mimir/keyset/v1";

export type Keyset = {
  readonly v: typeof KEYSET_VERSION;
  /** base64url raw X25519 private key. */
  readonly privateKey: string;
  /** base64url raw X25519 public key — duplicated into user.publicKey
   *  (plaintext) as the wrap target for org keys. */
  readonly publicKey: string;
};

export function generateKeyset() {
  const pair = generateKeypair();
  return {
    v: KEYSET_VERSION,
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
  } satisfies Keyset;
}

const keysetKey = (deviceSecret: string) =>
  deriveKey(fromB64u(deviceSecret), KEYSET_INFO);

/** Encrypt a keyset under the device secret → opaque base64url blob for
 *  `user.encryptedKeyset`. */
export const encryptKeyset = (deviceSecret: string, keyset: Keyset) =>
  toB64u(
    aesGcmSeal(
      keysetKey(deviceSecret),
      Buffer.from(JSON.stringify(keyset), "utf8"),
    ),
  );

/**
 * Decrypt and validate a keyset blob — throws on auth failure (wrong
 * secret, tampered blob), malformed JSON, version mismatch, or a
 * public/private key mismatch (corruption tripwire: the stored public
 * half must equal the one the private key derives).
 */
export function decryptKeyset(deviceSecret: string, encrypted: string) {
  const opened = aesGcmOpen(keysetKey(deviceSecret), fromB64u(encrypted));
  const parsed: unknown = JSON.parse(opened.toString("utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("v" in parsed) ||
    !("privateKey" in parsed) ||
    !("publicKey" in parsed) ||
    parsed.v !== KEYSET_VERSION ||
    typeof parsed.privateKey !== "string" ||
    typeof parsed.publicKey !== "string"
  ) {
    throw new Error("malformed keyset");
  }
  if (publicKeyFromPrivate(parsed.privateKey) !== parsed.publicKey) {
    throw new Error("keyset public/private key mismatch");
  }
  return {
    v: KEYSET_VERSION,
    privateKey: parsed.privateKey,
    publicKey: parsed.publicKey,
  } satisfies Keyset;
}
