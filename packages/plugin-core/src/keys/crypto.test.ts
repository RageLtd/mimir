import { describe, expect, test } from "bun:test";

import {
  aesGcmOpen,
  aesGcmSeal,
  fromB64u,
  generateKeypair,
  generateSymmetricKey,
  publicKeyFromPrivate,
  sealedBoxUnwrap,
  sealedBoxWrap,
  sharedSecret,
  toB64u,
} from "./crypto";

describe("x25519 keys", () => {
  test("keypair halves are raw 32-byte base64url", () => {
    const pair = generateKeypair();
    expect(fromB64u(pair.publicKey).length).toBe(32);
    expect(fromB64u(pair.privateKey).length).toBe(32);
  });

  test("public key recomputed from private matches the generated half", () => {
    // Pins the JWK empty-x import trick: node must derive the public
    // coordinate from d, not trust the placeholder.
    const pair = generateKeypair();
    expect(publicKeyFromPrivate(pair.privateKey)).toBe(pair.publicKey);
  });

  test("ECDH agrees in both directions", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    const ab = sharedSecret(a.privateKey, b.publicKey);
    const ba = sharedSecret(b.privateKey, a.publicKey);
    expect(ab.equals(ba)).toBe(true);
    expect(ab.length).toBe(32);
  });
});

describe("aes-256-gcm", () => {
  const key = fromB64u(generateSymmetricKey());

  test("round-trips", () => {
    const sealed = aesGcmSeal(key, Buffer.from("attack at dawn", "utf8"));
    expect(aesGcmOpen(key, sealed).toString("utf8")).toBe("attack at dawn");
  });

  test("nonce freshness: two seals of the same plaintext differ", () => {
    const plaintext = Buffer.from("same words twice", "utf8");
    const first = aesGcmSeal(key, plaintext);
    const second = aesGcmSeal(key, plaintext);
    expect(first.equals(second)).toBe(false);
  });

  test("tampered ciphertext fails authentication", () => {
    const sealed = aesGcmSeal(key, Buffer.from("integrity matters", "utf8"));
    const tampered = Buffer.from(sealed);
    // Flip a bit in the ciphertext body (past the 12-byte nonce).
    const target = tampered[13];
    if (target === undefined) throw new Error("sealed blob unexpectedly short");
    tampered[13] = target ^ 0xff;
    expect(() => aesGcmOpen(key, tampered)).toThrow();
  });

  test("wrong key fails authentication", () => {
    const sealed = aesGcmSeal(key, Buffer.from("secret", "utf8"));
    const wrongKey = fromB64u(generateSymmetricKey());
    expect(() => aesGcmOpen(wrongKey, sealed)).toThrow();
  });

  test("truncated blob is rejected before decryption", () => {
    expect(() => aesGcmOpen(key, Buffer.alloc(8))).toThrow("too short");
  });
});

describe("sealed box", () => {
  test("round-trips to the recipient", () => {
    const recipient = generateKeypair();
    const wrapped = sealedBoxWrap(recipient.publicKey, "the org keyring");
    expect(sealedBoxUnwrap(recipient.privateKey, wrapped)).toBe(
      "the org keyring",
    );
  });

  test("ephemeral keys make every wrap unique", () => {
    const recipient = generateKeypair();
    const first = sealedBoxWrap(recipient.publicKey, "same payload");
    const second = sealedBoxWrap(recipient.publicKey, "same payload");
    expect(first).not.toBe(second);
  });

  test("wrong recipient cannot open", () => {
    const recipient = generateKeypair();
    const interloper = generateKeypair();
    const wrapped = sealedBoxWrap(recipient.publicKey, "not for you");
    expect(() => sealedBoxUnwrap(interloper.privateKey, wrapped)).toThrow();
  });

  test("tampered blob fails", () => {
    const recipient = generateKeypair();
    const wrapped = sealedBoxWrap(recipient.publicKey, "fragile");
    const raw = fromB64u(wrapped).toString("utf8");
    const blob = JSON.parse(raw) as { ct: string };
    const ct = Buffer.from(blob.ct, "base64url");
    const target = ct[ct.length - 1];
    if (target === undefined) throw new Error("empty ciphertext");
    ct[ct.length - 1] = target ^ 0x01;
    const tampered = toB64u(
      Buffer.from(JSON.stringify({ ...blob, ct: toB64u(ct) }), "utf8"),
    );
    expect(() => sealedBoxUnwrap(recipient.privateKey, tampered)).toThrow();
  });

  test("garbage and version-mismatched blobs are rejected", () => {
    const recipient = generateKeypair();
    expect(() => sealedBoxUnwrap(recipient.privateKey, "not-a-blob")).toThrow();
    const wrongVersion = toB64u(
      Buffer.from(JSON.stringify({ v: 99, epk: "x", ct: "y" }), "utf8"),
    );
    expect(() => sealedBoxUnwrap(recipient.privateKey, wrongVersion)).toThrow(
      "malformed sealed box",
    );
  });
});
