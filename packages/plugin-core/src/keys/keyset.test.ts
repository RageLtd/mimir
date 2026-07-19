import { describe, expect, test } from "bun:test";

import { generateKeypair, generateSymmetricKey } from "./crypto";
import { decryptKeyset, encryptKeyset, generateKeyset } from "./keyset";

describe("keyset", () => {
  test("encrypt/decrypt round-trips under the device secret", () => {
    const deviceSecret = generateSymmetricKey();
    const keyset = generateKeyset();
    const blob = encryptKeyset(deviceSecret, keyset);
    expect(decryptKeyset(deviceSecret, blob)).toEqual(keyset);
  });

  test("wrong device secret fails authentication", () => {
    const keyset = generateKeyset();
    const blob = encryptKeyset(generateSymmetricKey(), keyset);
    expect(() => decryptKeyset(generateSymmetricKey(), blob)).toThrow();
  });

  test("public/private mismatch trips the corruption tripwire", () => {
    const deviceSecret = generateSymmetricKey();
    const keyset = generateKeyset();
    const forged = { ...keyset, publicKey: generateKeypair().publicKey };
    const blob = encryptKeyset(deviceSecret, forged);
    expect(() => decryptKeyset(deviceSecret, blob)).toThrow(
      "public/private key mismatch",
    );
  });

  test("garbage blob is rejected", () => {
    expect(() =>
      decryptKeyset(generateSymmetricKey(), "definitely-not-a-keyset"),
    ).toThrow();
  });
});
