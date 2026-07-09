/**
 * Org keyring — all live generations of an org's data key (MIM-87,
 * decided by Rage 2026-07-08). `member.wrappedOrgKey` is a sealed box
 * over this whole structure, so one unwrap yields every key needed to
 * read a mixed-generation store during rotation rollover (envelopes
 * carry their `key_gen`, THREAT_MODEL §6). Rotation appends generation
 * N+1; pruning old generations is MIM-88's re-encrypt job.
 */

import { generateSymmetricKey, sealedBoxUnwrap, sealedBoxWrap } from "./crypto";

export const KEYRING_VERSION = 1;

export type Keyring = {
  readonly v: typeof KEYRING_VERSION;
  /** generation (stringified positive int) → base64url 32-byte org key. */
  readonly keys: Readonly<Record<string, string>>;
};

const generations = (keyring: Keyring) =>
  Object.keys(keyring.keys)
    .map((generation) => Number.parseInt(generation, 10))
    .filter((generation) => Number.isInteger(generation) && generation > 0);

/** Fresh keyring at generation 1 — org key initialization. */
export const createKeyring = () => {
  // Variable annotation widens the literal `{"1": string}` to the
  // Keyring record shape callers index by arbitrary generation.
  const keyring: Keyring = {
    v: KEYRING_VERSION,
    keys: { "1": generateSymmetricKey() },
  };
  return keyring;
};

/** Highest generation present — the one new envelopes encrypt under. */
export function currentGeneration(keyring: Keyring) {
  const all = generations(keyring);
  if (all.length === 0) {
    throw new Error("keyring holds no generations");
  }
  return Math.max(...all);
}

/** The current generation's key material. */
export function currentKey(keyring: Keyring) {
  const generation = currentGeneration(keyring);
  const key = keyring.keys[String(generation)];
  if (!key) {
    throw new Error(`keyring missing key for generation ${generation}`);
  }
  return { generation, key };
}

/** Rotation: fresh key at generation N+1, prior generations retained
 *  for rollover reads. */
export function appendGeneration(keyring: Keyring) {
  const generation = currentGeneration(keyring) + 1;
  const rotated: Keyring = {
    v: KEYRING_VERSION,
    keys: { ...keyring.keys, [String(generation)]: generateSymmetricKey() },
  };
  return { keyring: rotated, generation };
}

/** Wrap the whole keyring to a member's (or recovery) public key —
 *  the value of `member.wrappedOrgKey` / `organization.wrappedRecoveryKey`. */
export const wrapKeyring = (recipientPublicKey: string, keyring: Keyring) =>
  sealedBoxWrap(recipientPublicKey, JSON.stringify(keyring));

/** Unwrap and validate — throws on auth failure, malformed shape, or an
 *  empty/invalid generation map. */
export function unwrapKeyring(recipientPrivateKey: string, wrapped: string) {
  const parsed: unknown = JSON.parse(
    sealedBoxUnwrap(recipientPrivateKey, wrapped),
  );
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("v" in parsed) ||
    !("keys" in parsed) ||
    parsed.v !== KEYRING_VERSION ||
    typeof parsed.keys !== "object" ||
    parsed.keys === null
  ) {
    throw new Error("malformed keyring");
  }
  const keys: Record<string, string> = {};
  for (const [generation, key] of Object.entries(parsed.keys)) {
    if (
      !Number.isInteger(Number.parseInt(generation, 10)) ||
      typeof key !== "string" ||
      key.length === 0
    ) {
      throw new Error("malformed keyring generation entry");
    }
    keys[generation] = key;
  }
  const keyring = { v: KEYRING_VERSION, keys } satisfies Keyring;
  // Validates at least one positive-integer generation exists.
  currentGeneration(keyring);
  return keyring;
}
