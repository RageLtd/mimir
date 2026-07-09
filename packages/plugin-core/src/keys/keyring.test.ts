import { describe, expect, test } from "bun:test";

import { generateKeypair, sealedBoxWrap } from "./crypto";
import {
  appendGeneration,
  createKeyring,
  currentGeneration,
  currentKey,
  unwrapKeyring,
  wrapKeyring,
} from "./keyring";

describe("keyring", () => {
  test("starts at generation 1", () => {
    const keyring = createKeyring();
    expect(currentGeneration(keyring)).toBe(1);
    expect(currentKey(keyring).generation).toBe(1);
  });

  test("rotation appends a fresh generation and keeps the old ones", () => {
    const keyring = createKeyring();
    const rotated = appendGeneration(keyring);
    expect(rotated.generation).toBe(2);
    expect(currentGeneration(rotated.keyring)).toBe(2);
    // Old generation survives for mixed-generation rollover reads.
    expect(rotated.keyring.keys["1"]).toBeDefined();
    expect(rotated.keyring.keys["1"]).toEqual(keyring.keys["1"]);
    expect(rotated.keyring.keys["2"]).not.toBe(rotated.keyring.keys["1"]);
  });

  test("wrap/unwrap round-trips to a member's key", () => {
    const member = generateKeypair();
    const keyring = appendGeneration(createKeyring()).keyring;
    const wrapped = wrapKeyring(member.publicKey, keyring);
    expect(unwrapKeyring(member.privateKey, wrapped)).toEqual(keyring);
  });

  test("wrong member cannot unwrap", () => {
    const member = generateKeypair();
    const interloper = generateKeypair();
    const wrapped = wrapKeyring(member.publicKey, createKeyring());
    expect(() => unwrapKeyring(interloper.privateKey, wrapped)).toThrow();
  });

  test("sealed non-keyring payloads are rejected on shape", () => {
    const member = generateKeypair();
    const notAKeyring = sealedBoxWrap(
      member.publicKey,
      JSON.stringify({ v: 1, keys: { "0": "" } }),
    );
    expect(() => unwrapKeyring(member.privateKey, notAKeyring)).toThrow(
      "malformed keyring",
    );
    const emptyKeys = sealedBoxWrap(
      member.publicKey,
      JSON.stringify({ v: 1, keys: {} }),
    );
    expect(() => unwrapKeyring(member.privateKey, emptyKeys)).toThrow(
      "no generations",
    );
  });
});
