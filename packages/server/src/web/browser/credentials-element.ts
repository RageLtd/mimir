type RegistrationOptionsJSON = {
  challenge: string;
  rp: PublicKeyCredentialRpEntity;
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: PublicKeyCredentialParameters[];
  timeout?: number;
  excludeCredentials?: Array<{
    id: string;
    type: PublicKeyCredentialType;
    transports?: AuthenticatorTransport[];
  }>;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  attestation?: AttestationConveyancePreference;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KEYSET_INFO = "mimir/keyset/v1";
const DEVICE_INFO = "mimir/browser-device/v1";
const SEALED_BOX_INFO = "mimir/sealed-box/v1";

export function toB64u(value: ArrayBuffer | Uint8Array) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function fromB64u(value: string) {
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function concat(...values: Uint8Array[]) {
  const joined = new Uint8Array(
    values.reduce((length, value) => length + value.length, 0),
  );
  let offset = 0;
  for (const value of values) {
    joined.set(value, offset);
    offset += value.length;
  }
  return joined;
}

export const buffer = (value: Uint8Array) => Uint8Array.from(value).buffer;

export async function json(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json();
}

export const post = (path: string, body: unknown) =>
  json(path, { method: "POST", body: JSON.stringify(body) });

export async function hkdfKey(
  material: Uint8Array,
  info: string,
  salt = new Uint8Array(),
) {
  const input = await crypto.subtle.importKey(
    "raw",
    buffer(material),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: buffer(salt),
      info: buffer(encoder.encode(info)),
    },
    input,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(
  key: CryptoKey,
  plaintext: Uint8Array,
  additionalData?: Uint8Array,
) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: buffer(nonce),
      ...(additionalData ? { additionalData: buffer(additionalData) } : {}),
    },
    key,
    buffer(plaintext),
  );
  return concat(nonce, new Uint8Array(ciphertext));
}

export async function open(
  key: CryptoKey,
  sealed: Uint8Array,
  additionalData?: Uint8Array,
) {
  if (sealed.length < 28) throw new Error("Encrypted value is malformed");
  return new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: buffer(sealed.slice(0, 12)),
        ...(additionalData ? { additionalData: buffer(additionalData) } : {}),
      },
      key,
      buffer(sealed.slice(12)),
    ),
  );
}

export async function generateKeyset() {
  const pair = await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ]);
  if (!("privateKey" in pair) || !("publicKey" in pair)) {
    throw new Error("X25519 is unavailable");
  }
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (!privateJwk.d || !publicJwk.x) throw new Error("X25519 is unavailable");
  return { v: 1, privateKey: privateJwk.d, publicKey: publicJwk.x };
}

export async function encryptKeyset(
  deviceSecret: Uint8Array,
  keyset: Awaited<ReturnType<typeof generateKeyset>>,
) {
  const key = await hkdfKey(deviceSecret, KEYSET_INFO);
  return toB64u(await seal(key, encoder.encode(JSON.stringify(keyset))));
}

export async function decryptKeyset(
  deviceSecret: Uint8Array,
  encrypted: string,
) {
  const key = await hkdfKey(deviceSecret, KEYSET_INFO);
  const value: unknown = JSON.parse(
    decoder.decode(await open(key, fromB64u(encrypted))),
  );
  if (
    typeof value !== "object" ||
    value === null ||
    Reflect.get(value, "v") !== 1 ||
    typeof Reflect.get(value, "privateKey") !== "string" ||
    typeof Reflect.get(value, "publicKey") !== "string"
  ) {
    throw new Error("Encrypted keyset is malformed");
  }
  return {
    v: 1,
    privateKey: Reflect.get(value, "privateKey") as string,
    publicKey: Reflect.get(value, "publicKey") as string,
  };
}

export async function unwrapKeyring(
  keyset: Awaited<ReturnType<typeof decryptKeyset>>,
  wrapped: string,
) {
  const blob: unknown = JSON.parse(decoder.decode(fromB64u(wrapped)));
  if (
    typeof blob !== "object" ||
    blob === null ||
    Reflect.get(blob, "v") !== 1 ||
    typeof Reflect.get(blob, "epk") !== "string" ||
    typeof Reflect.get(blob, "ct") !== "string"
  ) {
    throw new Error("Wrapped organization key is malformed");
  }
  const ephemeral = Reflect.get(blob, "epk") as string;
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "X25519", d: keyset.privateKey, x: keyset.publicKey },
    { name: "X25519" },
    false,
    ["deriveBits"],
  );
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "X25519", x: ephemeral },
    { name: "X25519" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "X25519", public: publicKey },
      privateKey,
      256,
    ),
  );
  const key = await hkdfKey(
    shared,
    SEALED_BOX_INFO,
    concat(fromB64u(ephemeral), fromB64u(keyset.publicKey)),
  );
  const opened = decoder.decode(
    await open(key, fromB64u(Reflect.get(blob, "ct") as string)),
  );
  const keyring: unknown = JSON.parse(opened);
  if (
    typeof keyring !== "object" ||
    keyring === null ||
    Reflect.get(keyring, "v") !== 1
  ) {
    throw new Error("Organization keyring is malformed");
  }
  return keyring;
}

export async function wrapKeyring(
  recipientPublicKey: string,
  keyring: unknown,
) {
  const pair = await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ]);
  if (!("privateKey" in pair) || !("publicKey" in pair)) {
    throw new Error("X25519 is unavailable");
  }
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  if (!privateJwk.d || !publicJwk.x) throw new Error("X25519 is unavailable");
  const recipient = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "X25519", x: recipientPublicKey },
    { name: "X25519" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "X25519", public: recipient },
      pair.privateKey,
      256,
    ),
  );
  const key = await hkdfKey(
    shared,
    SEALED_BOX_INFO,
    concat(fromB64u(publicJwk.x), fromB64u(recipientPublicKey)),
  );
  const blob = {
    v: 1,
    epk: publicJwk.x,
    ct: toB64u(await seal(key, encoder.encode(JSON.stringify(keyring)))),
  };
  return toB64u(encoder.encode(JSON.stringify(blob)));
}

function registrationResponse(credential: PublicKeyCredential) {
  if (!(credential.response instanceof AuthenticatorAttestationResponse)) {
    throw new Error("Unexpected passkey response");
  }
  return {
    id: credential.id,
    rawId: toB64u(credential.rawId),
    response: {
      clientDataJSON: toB64u(credential.response.clientDataJSON),
      attestationObject: toB64u(credential.response.attestationObject),
      transports: credential.response.getTransports?.() ?? [],
    },
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
  };
}

function prfOutput(credential: PublicKeyCredential) {
  const prf = Reflect.get(credential.getClientExtensionResults(), "prf");
  const results =
    typeof prf === "object" && prf ? Reflect.get(prf, "results") : null;
  const first =
    typeof results === "object" && results
      ? Reflect.get(results, "first")
      : null;
  return first instanceof ArrayBuffer ? new Uint8Array(first) : null;
}

export async function registerPasskey(
  name: string,
  salt: Uint8Array,
  requirePrf = false,
) {
  const query = new URLSearchParams({ name });
  const raw = (await json(
    `/api/auth/passkey/generate-register-options?${query}`,
  )) as RegistrationOptionsJSON;
  const credential = await navigator.credentials.create({
    publicKey: {
      ...raw,
      challenge: fromB64u(raw.challenge),
      user: { ...raw.user, id: fromB64u(raw.user.id) },
      excludeCredentials: raw.excludeCredentials?.map((item) => ({
        ...item,
        id: fromB64u(item.id),
      })),
      extensions: { prf: { eval: { first: buffer(salt) } } },
    },
  });
  if (!(credential instanceof PublicKeyCredential))
    throw new Error("Passkey registration was cancelled");
  const output = prfOutput(credential);
  if (requirePrf && !output) {
    throw new Error("This passkey does not support WebAuthn PRF");
  }
  await post("/api/auth/passkey/verify-registration", {
    response: registrationResponse(credential),
    name,
  });
  return { credentialId: credential.id, output };
}

export async function authenticate(credentialId: string, salt: Uint8Array) {
  const credential = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      userVerification: "required",
      allowCredentials: [{ id: fromB64u(credentialId), type: "public-key" }],
      extensions: { prf: { eval: { first: buffer(salt) } } },
    },
  });
  if (!(credential instanceof PublicKeyCredential))
    throw new Error("Passkey unlock was cancelled");
  const output = prfOutput(credential);
  if (!output) throw new Error("This passkey does not support WebAuthn PRF");
  // This assertion proves local authenticator possession only. Sending it to
  // Better Auth would turn every key unlock into a new login session; both
  // the challenge and PRF output stay in this browser instead.
  return output;
}

export async function wrapDeviceSecret(prf: Uint8Array, secret: Uint8Array) {
  return toB64u(await seal(await hkdfKey(prf, DEVICE_INFO), secret));
}

export async function unwrapDeviceSecret(prf: Uint8Array, wrapped: string) {
  return open(await hkdfKey(prf, DEVICE_INFO), fromB64u(wrapped));
}
