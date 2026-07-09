/**
 * Client-side crypto primitives for the E2E key-distribution layer
 * (MIM-87, THREAT_MODEL.md §5/§10).
 *
 * Bun-native `node:crypto` only — X25519 ECDH → HKDF-SHA-256 →
 * AES-256-GCM, zero dependencies (probed live on Bun 1.3.14). The keys/
 * directory is the ONLY place cipher primitives may be imported;
 * anything else importing node:crypto ciphers is an architecture bug.
 *
 * Error contract: these are thin throwing primitives, like node:crypto
 * itself — an AEAD auth failure or malformed blob throws. Flow-level
 * callers convert at the boundary with attemptSync (result.ts), keeping
 * this layer free of Result plumbing.
 *
 * Key representation at module boundaries: base64url strings of the raw
 * 32-byte X25519 coordinates (the JWK `x`/`d` fields verbatim), so keys
 * travel JSON-safe through config, server columns, and password
 * managers without a second encoding.
 */

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const AES_GCM = "aes-256-gcm";
const GCM_TAG_BYTES = 16;
const GCM_NONCE_BYTES = 12;
const KEY_BYTES = 32;
/** Domain separation for sealed-box key derivation (HKDF info). */
const SEALED_BOX_INFO = "mimir/sealed-box/v1";
export const SEALED_BOX_VERSION = 1;

export const toB64u = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString("base64url");
export const fromB64u = (text: string) => Buffer.from(text, "base64url");

/** Fresh 32 bytes, base64url — org keys, device secrets. */
export const generateSymmetricKey = () => toB64u(randomBytes(KEY_BYTES));

/** X25519 keypair as base64url raw coordinates. */
export function generateKeypair() {
  const pair = generateKeyPairSync("x25519");
  const jwk = pair.privateKey.export({ format: "jwk" });
  if (!jwk.d || !jwk.x) {
    throw new Error("x25519 keygen produced no raw coordinates");
  }
  return { publicKey: jwk.x, privateKey: jwk.d };
}

const privateKeyObject = (privateKey: string) =>
  createPrivateKey({
    key: { kty: "OKP", crv: "X25519", d: privateKey, x: "" },
    format: "jwk",
  });

const publicKeyObject = (publicKey: string) =>
  createPublicKey({
    key: { kty: "OKP", crv: "X25519", x: publicKey },
    format: "jwk",
  });

/** Recompute the public half from a raw private key — recovery-key
 *  validation and new-device keyset verification. */
export function publicKeyFromPrivate(privateKey: string) {
  const jwk = createPublicKey(privateKeyObject(privateKey)).export({
    format: "jwk",
  });
  if (!jwk.x) {
    throw new Error("x25519 public derivation produced no coordinate");
  }
  return jwk.x;
}

/** Raw ECDH shared secret (32 bytes) between a private and public key. */
export const sharedSecret = (privateKey: string, publicKey: string) =>
  diffieHellman({
    privateKey: privateKeyObject(privateKey),
    publicKey: publicKeyObject(publicKey),
  });

/** HKDF-SHA-256 → 32-byte key. `info` carries the domain separation;
 *  `salt` binds context (e.g. the public keys of a sealed box). */
export const deriveKey = (ikm: Uint8Array, info: string, salt?: Uint8Array) =>
  Buffer.from(
    hkdfSync("sha256", ikm, salt ?? Buffer.alloc(0), info, KEY_BYTES),
  );

/**
 * AES-256-GCM seal: fresh random 96-bit nonce per call (THREAT_MODEL §6
 * nonce policy — never cached, never counter-derived). Returns
 * nonce ‖ ciphertext ‖ tag as one buffer. Optional AAD binds context —
 * the envelope seam (sync) passes the §6 canonical field encoding so a
 * transplanted ciphertext fails authentication.
 */
export function aesGcmSeal(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad?: Uint8Array,
) {
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const cipher = createCipheriv(AES_GCM, key, nonce);
  if (aad) cipher.setAAD(aad);
  return Buffer.concat([
    nonce,
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
}

/** AES-256-GCM open — throws on truncation, auth failure, or AAD
 *  mismatch. */
export function aesGcmOpen(
  key: Uint8Array,
  sealed: Uint8Array,
  aad?: Uint8Array,
) {
  if (sealed.length < GCM_NONCE_BYTES + GCM_TAG_BYTES) {
    throw new Error("sealed blob too short");
  }
  const buffer = Buffer.from(sealed);
  const nonce = buffer.subarray(0, GCM_NONCE_BYTES);
  const tag = buffer.subarray(buffer.length - GCM_TAG_BYTES);
  const ciphertext = buffer.subarray(
    GCM_NONCE_BYTES,
    buffer.length - GCM_TAG_BYTES,
  );
  const decipher = createDecipheriv(AES_GCM, key, nonce);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Sealed box: encrypt to a recipient's public key with a fresh ephemeral
 * sender key (invite/recovery wrapping shape, THREAT_MODEL §5). The HKDF
 * salt binds both public keys, so a blob transplanted between recipients
 * fails authentication. Output is base64url JSON — an opaque string the
 * server stores without understanding.
 */
export function sealedBoxWrap(recipientPublicKey: string, plaintext: string) {
  const ephemeral = generateKeypair();
  const key = deriveKey(
    sharedSecret(ephemeral.privateKey, recipientPublicKey),
    SEALED_BOX_INFO,
    Buffer.concat([
      fromB64u(ephemeral.publicKey),
      fromB64u(recipientPublicKey),
    ]),
  );
  const sealed = aesGcmSeal(key, Buffer.from(plaintext, "utf8"));
  const blob = {
    v: SEALED_BOX_VERSION,
    epk: ephemeral.publicKey,
    ct: toB64u(sealed),
  };
  return toB64u(Buffer.from(JSON.stringify(blob), "utf8"));
}

/** Open a sealed box with the recipient's private key — throws on
 *  malformed blobs, version mismatch, or auth failure. */
export function sealedBoxUnwrap(recipientPrivateKey: string, wrapped: string) {
  const parsed: unknown = JSON.parse(fromB64u(wrapped).toString("utf8"));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("v" in parsed) ||
    !("epk" in parsed) ||
    !("ct" in parsed) ||
    parsed.v !== SEALED_BOX_VERSION ||
    typeof parsed.epk !== "string" ||
    typeof parsed.ct !== "string"
  ) {
    throw new Error("malformed sealed box");
  }
  const recipientPublicKey = publicKeyFromPrivate(recipientPrivateKey);
  const key = deriveKey(
    sharedSecret(recipientPrivateKey, parsed.epk),
    SEALED_BOX_INFO,
    Buffer.concat([fromB64u(parsed.epk), fromB64u(recipientPublicKey)]),
  );
  return aesGcmOpen(key, fromB64u(parsed.ct)).toString("utf8");
}
