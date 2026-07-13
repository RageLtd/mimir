import { describe, expect, test } from "bun:test";
import {
  openEnvelope,
  sealEnvelope,
  type EnvelopeCipher,
} from "@mimir/plugin-core/sync/envelope";
import { toB64u } from "./credentials-element";
import {
  clearUnlocked,
  openMemoryEnvelope,
  sealMemoryEnvelope,
  type UnlockedKeys,
} from "./memory-crypto";

const setup = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const encoded = toB64u(bytes);
  const unlocked: UnlockedKeys = {
    deviceSecret: crypto.getRandomValues(new Uint8Array(32)),
    generation: 1,
    keys: new Map([[1, bytes]]),
  };
  const cipher: EnvelopeCipher = {
    mode: "keyring",
    keyring: { v: 1, keys: { "1": encoded } },
  };
  return { unlocked, cipher };
};

describe("browser envelope compatibility", () => {
  test("browser-sealed payload opens in the canonical plugin seam", async () => {
    const { unlocked, cipher } = setup();
    const plaintext = JSON.stringify({ content: "never on the wire" });
    const envelope = await sealMemoryEnvelope({
      id: "memory:browser",
      orgId: "org-1",
      version: 1,
      tombstone: false,
      payload: plaintext,
      unlocked,
    });

    expect(JSON.stringify(envelope)).not.toContain("never on the wire");
    expect(openEnvelope(envelope, { orgId: "org-1", cipher }).payload).toBe(
      plaintext,
    );
  });

  test("canonical plugin payload opens in Web Crypto and rejects transplant", async () => {
    const { unlocked, cipher } = setup();
    const envelope = sealEnvelope({
      id: "memory:plugin",
      orgId: "org-1",
      kind: 1,
      version: 4,
      tombstone: false,
      payload: "private payload",
      cipher,
    });

    await expect(
      openMemoryEnvelope(envelope, "org-1", unlocked.keys),
    ).resolves.toBe("private payload");
    await expect(
      openMemoryEnvelope(envelope, "org-2", unlocked.keys),
    ).rejects.toThrow();
    await expect(
      openMemoryEnvelope({ ...envelope, version: 5 }, "org-1", unlocked.keys),
    ).rejects.toThrow();
    await expect(
      openMemoryEnvelope(
        { ...envelope, tombstone: true },
        "org-1",
        unlocked.keys,
      ),
    ).rejects.toThrow();
  });

  test("browser tombstones carry authenticated ciphertext", async () => {
    const { unlocked, cipher } = setup();
    const envelope = await sealMemoryEnvelope({
      id: "memory:deleted",
      orgId: "org-1",
      version: 2,
      tombstone: true,
      payload: "ignored",
      unlocked,
    });

    expect(envelope.nonce).not.toBe("");
    expect(envelope.payload).not.toBe("");
    expect(openEnvelope(envelope, { orgId: "org-1", cipher }).payload).toBeNull();
  });

  test("lock zeroes device and organization key material", () => {
    const { unlocked } = setup();
    const device = unlocked.deviceSecret;
    const key = unlocked.keys.get(1);
    clearUnlocked(unlocked);
    expect(device.every((byte) => byte === 0)).toBe(true);
    expect(key?.every((byte) => byte === 0)).toBe(true);
    expect(unlocked.keys.size).toBe(0);
  });
});
