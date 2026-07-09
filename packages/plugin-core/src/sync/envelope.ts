/**
 * Ciphertext envelope seam (MIM-88) — the ONE place tenant content meets
 * a cipher (THREAT_MODEL §10). Everything above (replica, brain) reads
 * plaintext; everything below (HTTP, server) carries opaque envelopes.
 *
 * Format v1 is FROZEN (THREAT_MODEL §6): the server may index every
 * field; it never parses the payload. Payload = AEAD ct ‖ 16-byte tag;
 * nonce is its own 12-byte field. AAD binds
 * `envelope_v ‖ suite ‖ kind ‖ id ‖ org_id ‖ key_gen`, so a server that
 * transplants a ciphertext onto a different record, org, kind, or
 * generation produces an authentication failure client-side.
 *
 * Suites: 0x01 AES-256-GCM (cloud default, key from the org keyring by
 * generation); 0x00 plaintext — the self-hosted toggle (§9). Same seam,
 * same shape, one branch. Tombstones carry an EMPTY payload by spec.
 *
 * Cipher primitives come from keys/crypto — node:crypto stays confined
 * to the keys/ directory.
 */

import { aesGcmOpen, aesGcmSeal, fromB64u, toB64u } from "../keys/crypto";
import { currentKey, type Keyring } from "../keys/keyring";

export const ENVELOPE_VERSION = 1;
export const SUITE_PLAINTEXT = 0x00;
export const SUITE_AES_256_GCM = 0x01;
export const KIND_MEMORY = 0x01;
export const KIND_PLAYBOOK = 0x02;
const GCM_NONCE_BYTES = 12;

/** The wire shape both /v1/sync directions carry. All byte fields are
 *  base64url strings so envelopes travel as plain JSON. */
export type WireEnvelope = {
  readonly id: string;
  readonly kind: number;
  readonly v: number;
  readonly suite: number;
  readonly keyGen: number;
  readonly version: number;
  readonly tombstone: boolean;
  readonly nonce: string;
  readonly payload: string;
};

/** Encryption mode — the §9 toggle lives here and nowhere else. */
export type EnvelopeCipher =
  | { readonly mode: "keyring"; readonly keyring: Keyring }
  | { readonly mode: "plaintext" };

/**
 * Canonical AAD encoding (§6): 1-byte v ‖ 1-byte suite ‖ 1-byte kind ‖
 * uint32BE key_gen ‖ utf8(id) ‖ 0x00 ‖ utf8(org_id). The NUL separator
 * keeps (id, org_id) pairs unambiguous; ids never contain NUL.
 */
export function envelopeAad(fields: {
  suite: number;
  kind: number;
  id: string;
  orgId: string;
  keyGen: number;
}) {
  const keyGen = Buffer.alloc(4);
  keyGen.writeUInt32BE(fields.keyGen);
  return Buffer.concat([
    Buffer.from([ENVELOPE_VERSION, fields.suite, fields.kind]),
    keyGen,
    Buffer.from(fields.id, "utf8"),
    Buffer.from([0]),
    Buffer.from(fields.orgId, "utf8"),
  ]);
}

export type SealInput = {
  readonly id: string;
  readonly orgId: string;
  readonly kind: number;
  readonly version: number;
  readonly tombstone: boolean;
  /** Plaintext payload JSON — ignored (forced empty) for tombstones. */
  readonly payload: string;
  readonly cipher: EnvelopeCipher;
};

/** Produce a wire envelope. Fresh nonce per call inside aesGcmSeal —
 *  never cached, never derived (§6 nonce policy). */
export function sealEnvelope(input: SealInput) {
  const base = {
    id: input.id,
    kind: input.kind,
    v: ENVELOPE_VERSION,
    version: input.version,
    tombstone: input.tombstone,
  };
  // Tombstones carry no payload by spec — deletion needs no content.
  if (input.tombstone) {
    const suite =
      input.cipher.mode === "plaintext" ? SUITE_PLAINTEXT : SUITE_AES_256_GCM;
    const keyGen =
      input.cipher.mode === "keyring"
        ? currentKey(input.cipher.keyring).generation
        : 0;
    return {
      ...base,
      suite,
      keyGen,
      nonce: "",
      payload: "",
    } satisfies WireEnvelope;
  }
  if (input.cipher.mode === "plaintext") {
    return {
      ...base,
      suite: SUITE_PLAINTEXT,
      keyGen: 0,
      nonce: "",
      payload: toB64u(Buffer.from(input.payload, "utf8")),
    } satisfies WireEnvelope;
  }
  const { generation, key } = currentKey(input.cipher.keyring);
  const aad = envelopeAad({
    suite: SUITE_AES_256_GCM,
    kind: input.kind,
    id: input.id,
    orgId: input.orgId,
    keyGen: generation,
  });
  const sealed = aesGcmSeal(
    fromB64u(key),
    Buffer.from(input.payload, "utf8"),
    aad,
  );
  return {
    ...base,
    suite: SUITE_AES_256_GCM,
    keyGen: generation,
    nonce: toB64u(sealed.subarray(0, GCM_NONCE_BYTES)),
    payload: toB64u(sealed.subarray(GCM_NONCE_BYTES)),
  } satisfies WireEnvelope;
}

const assertShape = (envelope: WireEnvelope) => {
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new Error(`unsupported envelope version ${envelope.v}`);
  }
  if (
    envelope.suite !== SUITE_PLAINTEXT &&
    envelope.suite !== SUITE_AES_256_GCM
  ) {
    throw new Error(`unsupported envelope suite ${envelope.suite}`);
  }
};

/**
 * Open a wire envelope. Throws on version/suite mismatch, missing key
 * generation, or authentication failure (tampered payload OR any AAD
 * field the server might have rewritten). Tombstones return a null
 * payload — there is nothing to decrypt by construction.
 */
export function openEnvelope(
  envelope: WireEnvelope,
  context: { readonly orgId: string; readonly cipher: EnvelopeCipher },
) {
  assertShape(envelope);
  const opened = {
    id: envelope.id,
    kind: envelope.kind,
    version: envelope.version,
    tombstone: envelope.tombstone,
  };
  if (envelope.tombstone) {
    return { ...opened, payload: null };
  }
  if (envelope.suite === SUITE_PLAINTEXT) {
    return { ...opened, payload: fromB64u(envelope.payload).toString("utf8") };
  }
  if (context.cipher.mode !== "keyring") {
    throw new Error("encrypted envelope but no keyring available");
  }
  const key = context.cipher.keyring.keys[String(envelope.keyGen)];
  if (!key) {
    throw new Error(
      `keyring holds no generation ${envelope.keyGen} — re-pull the org wrap`,
    );
  }
  const aad = envelopeAad({
    suite: envelope.suite,
    kind: envelope.kind,
    id: envelope.id,
    orgId: context.orgId,
    keyGen: envelope.keyGen,
  });
  const sealed = Buffer.concat([
    fromB64u(envelope.nonce),
    fromB64u(envelope.payload),
  ]);
  const payload = aesGcmOpen(fromB64u(key), sealed, aad).toString("utf8");
  return { ...opened, payload };
}
