import {
  authenticate,
  buffer,
  concat,
  decryptKeyset,
  fromB64u,
  json,
  open,
  seal,
  toB64u,
  unwrapDeviceSecret,
  unwrapKeyring,
} from "./credentials-element";
import {
  ENVELOPE_VERSION,
  KIND_MEMORY,
  SUITE_AES_256_GCM,
  type WireEnvelope,
} from "./memory-model";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_GENERATION = 0xffff_ffff;

type DeviceEnvelope = {
  credentialId: string;
  salt: string;
  wrappedSecret: string;
};

export type UnlockedKeys = {
  deviceSecret: Uint8Array;
  generation: number;
  keys: Map<number, Uint8Array>;
};

function readDeviceEnvelope(userId: string) {
  const stored = localStorage.getItem(`mimir:device:${userId}`);
  if (!stored) throw new Error("Enroll this browser on the Credentials page");
  const parsed: unknown = JSON.parse(stored);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Reflect.get(parsed, "v") !== 1 ||
    typeof Reflect.get(parsed, "credentialId") !== "string" ||
    typeof Reflect.get(parsed, "salt") !== "string" ||
    typeof Reflect.get(parsed, "wrappedSecret") !== "string"
  ) {
    throw new Error("Stored browser enrollment is unsupported");
  }
  return {
    credentialId: Reflect.get(parsed, "credentialId") as string,
    salt: Reflect.get(parsed, "salt") as string,
    wrappedSecret: Reflect.get(parsed, "wrappedSecret") as string,
  } satisfies DeviceEnvelope;
}

function readKeyring(value: unknown, generation: number) {
  if (
    typeof value !== "object" ||
    value === null ||
    Reflect.get(value, "v") !== 1
  ) {
    throw new Error("Organization keyring is malformed");
  }
  const raw = Reflect.get(value, "keys");
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Organization keyring is malformed");
  }
  const keys = new Map<number, Uint8Array>();
  for (const [name, encoded] of Object.entries(raw)) {
    const number = Number(name);
    if (
      !Number.isInteger(number) ||
      number < 1 ||
      number > MAX_GENERATION ||
      typeof encoded !== "string"
    ) {
      throw new Error("Organization keyring is malformed");
    }
    const key = fromB64u(encoded);
    if (key.length !== 32) throw new Error("Organization key is malformed");
    keys.set(number, key);
  }
  if (!keys.has(generation)) {
    for (const key of keys.values()) key.fill(0);
    throw new Error("Organization key generation is unavailable");
  }
  return keys;
}

export async function unlockKeys(userId: string) {
  const enrolled = readDeviceEnvelope(userId);
  const prf = await authenticate(
    enrolled.credentialId,
    fromB64u(enrolled.salt),
  );
  const secret = await unwrapDeviceSecret(prf, enrolled.wrappedSecret);
  prf.fill(0);
  try {
    const state: unknown = await json("/v1/keys/org");
    if (typeof state !== "object" || state === null) {
      throw new Error("Key state is malformed");
    }
    const generation = Reflect.get(state, "keyGeneration");
    const self = Reflect.get(state, "self");
    const encrypted =
      typeof self === "object" && self
        ? Reflect.get(self, "encryptedKeyset")
        : null;
    const wrapped =
      typeof self === "object" && self
        ? Reflect.get(self, "wrappedOrgKey")
        : null;
    if (
      !Number.isInteger(generation) ||
      Number(generation) < 1 ||
      typeof encrypted !== "string" ||
      typeof wrapped !== "string"
    ) {
      throw new Error("Organization keys are not ready for this browser");
    }
    const keyset = await decryptKeyset(secret, encrypted);
    const keyring = await unwrapKeyring(keyset, wrapped);
    return {
      deviceSecret: secret,
      generation: Number(generation),
      keys: readKeyring(keyring, Number(generation)),
    } satisfies UnlockedKeys;
  } catch (error) {
    secret.fill(0);
    throw error;
  }
}

function envelopeAad(envelope: {
  suite: number;
  kind: number;
  id: string;
  orgId: string;
  keyGen: number;
  version: number;
  tombstone: boolean;
}) {
  const generation = new Uint8Array(4);
  new DataView(generation.buffer).setUint32(0, envelope.keyGen);
  const version = new Uint8Array(8);
  new DataView(version.buffer).setBigUint64(0, BigInt(envelope.version));
  return concat(
    new Uint8Array([ENVELOPE_VERSION, envelope.suite, envelope.kind]),
    generation,
    version,
    new Uint8Array([envelope.tombstone ? 1 : 0]),
    encoder.encode(envelope.id),
    new Uint8Array([0]),
    encoder.encode(envelope.orgId),
  );
}

async function importEnvelopeKey(key: Uint8Array, usage: KeyUsage) {
  return crypto.subtle.importKey(
    "raw",
    buffer(key),
    { name: "AES-GCM" },
    false,
    [usage],
  );
}

export async function openMemoryEnvelope(
  envelope: WireEnvelope,
  orgId: string,
  keys: Map<number, Uint8Array>,
) {
  const key = keys.get(envelope.keyGen);
  if (!key) throw new Error("Memory uses an unavailable key generation");
  const nonce = fromB64u(envelope.nonce);
  const payload = fromB64u(envelope.payload);
  if (nonce.length !== 12 || payload.length < 16) {
    throw new Error("Encrypted memory is malformed");
  }
  const opened = await open(
    await importEnvelopeKey(key, "decrypt"),
    concat(nonce, payload),
    envelopeAad({
      suite: envelope.suite,
      kind: envelope.kind,
      id: envelope.id,
      orgId,
      keyGen: envelope.keyGen,
      version: envelope.version,
      tombstone: envelope.tombstone,
    }),
  );
  if (envelope.tombstone) {
    if (opened.length !== 0)
      throw new Error("Encrypted tombstone is malformed");
    return null;
  }
  return decoder.decode(opened);
}

export async function sealMemoryEnvelope(input: {
  id: string;
  orgId: string;
  version: number;
  tombstone: boolean;
  payload: string;
  unlocked: UnlockedKeys;
}) {
  const base = {
    id: input.id,
    kind: KIND_MEMORY,
    v: ENVELOPE_VERSION,
    suite: SUITE_AES_256_GCM,
    keyGen: input.unlocked.generation,
    version: input.version,
    tombstone: input.tombstone,
  };
  const key = input.unlocked.keys.get(input.unlocked.generation);
  if (!key) throw new Error("Current organization key is unavailable");
  const sealed = await seal(
    await importEnvelopeKey(key, "encrypt"),
    input.tombstone ? new Uint8Array() : encoder.encode(input.payload),
    envelopeAad({
      suite: base.suite,
      kind: base.kind,
      id: base.id,
      orgId: input.orgId,
      keyGen: base.keyGen,
      version: base.version,
      tombstone: base.tombstone,
    }),
  );
  return {
    ...base,
    nonce: toB64u(sealed.slice(0, 12)),
    payload: toB64u(sealed.slice(12)),
  } satisfies WireEnvelope;
}

export function clearUnlocked(unlocked: UnlockedKeys | undefined) {
  if (!unlocked) return;
  unlocked.deviceSecret.fill(0);
  for (const key of unlocked.keys.values()) key.fill(0);
  unlocked.keys.clear();
}
