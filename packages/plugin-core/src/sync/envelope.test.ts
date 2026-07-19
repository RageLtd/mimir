/**
 * Envelope seam tests — the THREAT_MODEL §10 obligations that belong to
 * the sync seam: AAD-tamper/transplant failure, key-generation rollover,
 * plaintext toggle parity. (Nonce freshness is pinned at the primitive
 * level in keys/crypto.test.ts and re-checked here at envelope level.)
 */

import { describe, expect, test } from "bun:test";

import { appendGeneration, createKeyring } from "../keys/keyring";
import {
  ENVELOPE_VERSION,
  KIND_MEMORY,
  KIND_PLAYBOOK,
  openEnvelope,
  SUITE_AES_256_GCM,
  SUITE_PLAINTEXT,
  sealEnvelope,
  type WireEnvelope,
} from "./envelope";

const ORG = "org-alpha";
const PAYLOAD = JSON.stringify({ content: "the dwarves demand quality" });

const keyringCipher = () =>
  ({ mode: "keyring", keyring: createKeyring() }) as const;

const seal = (overrides?: Partial<Parameters<typeof sealEnvelope>[0]>) =>
  sealEnvelope({
    id: "memory:abc123",
    orgId: ORG,
    kind: KIND_MEMORY,
    version: 3,
    tombstone: false,
    payload: PAYLOAD,
    cipher: keyringCipher(),
    ...overrides,
  });

describe("encrypted envelopes (suite 0x01)", () => {
  test("round-trips through the keyring", () => {
    const cipher = keyringCipher();
    const envelope = seal({ cipher });
    expect(envelope.suite).toBe(SUITE_AES_256_GCM);
    expect(envelope.keyGen).toBe(1);
    const opened = openEnvelope(envelope, { orgId: ORG, cipher });
    expect(opened.payload).toBe(PAYLOAD);
    expect(opened.version).toBe(3);
  });

  test("fresh nonce per seal — same input, different wire bytes", () => {
    const cipher = keyringCipher();
    const first = seal({ cipher });
    const second = seal({ cipher });
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.payload).not.toBe(second.payload);
  });

  test("payload is not the plaintext (operator-blindness sanity)", () => {
    const envelope = seal();
    expect(
      Buffer.from(envelope.payload, "base64url").toString("utf8"),
    ).not.toContain("dwarves");
  });

  test("transplanted id fails authentication", () => {
    const cipher = keyringCipher();
    const envelope = seal({ cipher });
    const transplanted = { ...envelope, id: "memory:other" };
    expect(() => openEnvelope(transplanted, { orgId: ORG, cipher })).toThrow();
  });

  test("transplanted org fails authentication", () => {
    const cipher = keyringCipher();
    const envelope = seal({ cipher });
    expect(() =>
      openEnvelope(envelope, { orgId: "org-beta", cipher }),
    ).toThrow();
  });

  test("rewritten kind fails authentication", () => {
    const cipher = keyringCipher();
    const envelope = seal({ cipher });
    const rewritten = { ...envelope, kind: KIND_PLAYBOOK };
    expect(() => openEnvelope(rewritten, { orgId: ORG, cipher })).toThrow();
  });

  test("rewritten keyGen fails (wrong key or AAD mismatch)", () => {
    const keyring = appendGeneration(createKeyring()).keyring;
    const cipher = { mode: "keyring", keyring } as const;
    const envelope = seal({ cipher }); // sealed at gen 2
    const rewritten = { ...envelope, keyGen: 1 };
    expect(() => openEnvelope(rewritten, { orgId: ORG, cipher })).toThrow();
  });

  test("rewritten record version fails authentication", () => {
    const cipher = keyringCipher();
    const envelope = seal({ cipher });
    expect(() =>
      openEnvelope({ ...envelope, version: 999 }, { orgId: ORG, cipher }),
    ).toThrow();
  });

  test("forged tombstone fails authentication", () => {
    const cipher = keyringCipher();
    const envelope = seal({ cipher });
    expect(() =>
      openEnvelope({ ...envelope, tombstone: true }, { orgId: ORG, cipher }),
    ).toThrow();
  });

  test("tampered payload fails authentication", () => {
    const cipher = keyringCipher();
    const envelope = seal({ cipher });
    const bytes = Buffer.from(envelope.payload, "base64url");
    const target = bytes[0];
    if (target === undefined) throw new Error("empty payload");
    bytes[0] = target ^ 0xff;
    const tampered = { ...envelope, payload: bytes.toString("base64url") };
    expect(() => openEnvelope(tampered, { orgId: ORG, cipher })).toThrow();
  });

  test("rollover: gen-1 envelope opens with a rotated gen-1+2 keyring", () => {
    const original = createKeyring();
    const envelope = seal({ cipher: { mode: "keyring", keyring: original } });
    const rotated = appendGeneration(original).keyring;
    const opened = openEnvelope(envelope, {
      orgId: ORG,
      cipher: { mode: "keyring", keyring: rotated },
    });
    expect(opened.payload).toBe(PAYLOAD);
  });

  test("missing generation reports which one is needed", () => {
    // Sealed at gen 2, opened with a keyring holding only gen 1 — the
    // reader has not re-pulled its wrap since rotation.
    const rotated = appendGeneration(createKeyring()).keyring;
    const envelope = seal({ cipher: { mode: "keyring", keyring: rotated } });
    const stale = createKeyring();
    expect(() =>
      openEnvelope(envelope, {
        orgId: ORG,
        cipher: { mode: "keyring", keyring: stale },
      }),
    ).toThrow("no generation 2");
  });

  test("encrypted envelope without a keyring is refused", () => {
    const envelope = seal();
    expect(() =>
      openEnvelope(envelope, { orgId: ORG, cipher: { mode: "plaintext" } }),
    ).toThrow("no keyring");
  });
});

describe("plaintext toggle (suite 0x00, self-hosted)", () => {
  test("round-trips without key material", () => {
    const cipher = { mode: "plaintext" } as const;
    const envelope = seal({ cipher });
    expect(envelope.suite).toBe(SUITE_PLAINTEXT);
    expect(envelope.keyGen).toBe(0);
    expect(envelope.nonce).toBe("");
    const opened = openEnvelope(envelope, { orgId: ORG, cipher });
    expect(opened.payload).toBe(PAYLOAD);
  });
});

describe("tombstones", () => {
  test("encrypted deletion intent is authenticated", () => {
    const cipher = keyringCipher();
    const envelope = seal({ tombstone: true, cipher });
    expect(envelope.nonce).not.toBe("");
    expect(envelope.payload).not.toBe("");
    const opened = openEnvelope(envelope, { orgId: ORG, cipher });
    expect(opened.tombstone).toBe(true);
    expect(opened.payload).toBeNull();
  });

  test("trusted plaintext self-hosting keeps empty tombstones", () => {
    const cipher = { mode: "plaintext" } as const;
    const envelope = seal({ tombstone: true, cipher });
    expect(envelope.payload).toBe("");
    expect(openEnvelope(envelope, { orgId: ORG, cipher }).payload).toBeNull();
  });
});

describe("shape guards", () => {
  test("legacy, unknown version, and unknown suite are rejected", () => {
    const envelope = seal({ cipher: { mode: "plaintext" } });
    const legacy: WireEnvelope = { ...envelope, v: 1 };
    expect(() =>
      openEnvelope(legacy, { orgId: ORG, cipher: { mode: "plaintext" } }),
    ).toThrow("version");
    const wrongVersion: WireEnvelope = { ...envelope, v: ENVELOPE_VERSION + 1 };
    expect(() =>
      openEnvelope(wrongVersion, { orgId: ORG, cipher: { mode: "plaintext" } }),
    ).toThrow("version");
    const wrongSuite: WireEnvelope = { ...envelope, suite: 0x7f };
    expect(() =>
      openEnvelope(wrongSuite, { orgId: ORG, cipher: { mode: "plaintext" } }),
    ).toThrow("suite");
  });
});
