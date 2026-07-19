import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fromB64u } from "./crypto";
import {
  ensureDeviceSecret,
  fileSecretStore,
  generateDeviceSecret,
  getDeviceSecret,
  type SecretStore,
  secretName,
  storeDeviceSecret,
} from "./device-secret";

/** In-memory store — tests must never touch the developer's keychain. */
const memoryStore = () => {
  const entries = new Map<string, string>();
  return {
    get: async (name: string) => entries.get(name) ?? null,
    set: async (name: string, value: string) => {
      entries.set(name, value);
    },
  } satisfies SecretStore;
};

const SERVER = "https://mimir.example.com:8443";

describe("secretName", () => {
  test("keys by server host including port", () => {
    expect(secretName(SERVER)).toBe("device-secret:mimir.example.com:8443");
    expect(secretName("http://localhost:8020/api")).toBe(
      "device-secret:localhost:8020",
    );
  });

  test("rejects garbage urls", () => {
    expect(() => secretName("not a url")).toThrow();
  });
});

describe("ensureDeviceSecret", () => {
  test("generates once, then returns the stored secret", async () => {
    const store = memoryStore();
    const first = await ensureDeviceSecret(SERVER, store);
    expect(first.created).toBe(true);
    expect(fromB64u(first.secret).length).toBe(32);
    const second = await ensureDeviceSecret(SERVER, store);
    expect(second.created).toBe(false);
    expect(second.secret).toBe(first.secret);
  });

  test("distinct servers get distinct secrets", async () => {
    const store = memoryStore();
    const a = await ensureDeviceSecret("https://a.example.com", store);
    const b = await ensureDeviceSecret("https://b.example.com", store);
    expect(a.secret).not.toBe(b.secret);
  });
});

describe("store/get round-trip", () => {
  test("stores a pasted secret and reads it back", async () => {
    const store = memoryStore();
    const secret = generateDeviceSecret();
    await storeDeviceSecret(SERVER, secret, store);
    expect(await getDeviceSecret(SERVER, store)).toBe(secret);
  });

  test("missing secret reads as null (new-device signal)", async () => {
    expect(await getDeviceSecret(SERVER, memoryStore())).toBeNull();
  });

  test("rejects malformed secrets before persisting", async () => {
    const store = memoryStore();
    await expect(storeDeviceSecret(SERVER, "too-short", store)).rejects.toThrow(
      "32 bytes",
    );
  });
});

describe("fileSecretStore fallback", () => {
  const tempPath = () =>
    join(mkdtempSync(join(tmpdir(), "mimir-keys-")), "device-secret.enc");

  test("round-trips through the passphrase-encrypted file", async () => {
    const path = tempPath();
    const store = fileSecretStore("correct horse battery staple", path);
    const secret = generateDeviceSecret();
    await store.set("device-secret:host", secret);
    expect(await store.get("device-secret:host")).toBe(secret);
    // A second entry coexists in the same file.
    const other = generateDeviceSecret();
    await store.set("device-secret:other", other);
    expect(await store.get("device-secret:host")).toBe(secret);
    expect(await store.get("device-secret:other")).toBe(other);
  });

  test("wrong passphrase fails authentication", async () => {
    const path = tempPath();
    const secret = generateDeviceSecret();
    await fileSecretStore("right", path).set("name", secret);
    await expect(fileSecretStore("wrong", path).get("name")).rejects.toThrow();
  });

  test("missing file reads as null", async () => {
    const store = fileSecretStore("any", tempPath());
    expect(await store.get("nothing")).toBeNull();
  });

  test("empty passphrase is refused", () => {
    expect(() => fileSecretStore("", tempPath())).toThrow("empty passphrase");
  });
});
