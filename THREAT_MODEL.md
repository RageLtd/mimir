# Mimir Threat Model & Ciphertext Envelope Specification

**Version:** 1 (envelope format frozen)
**Status:** MIM-83 deliverable, under the MIM-82 operator-blind epic
**Beta gate:** users connect to the cloud server when MIM-82 completes

---

## 1. The Guarantee

**The operator of a Mimir cloud server can never read tenant content. No asterisks.**

"Content" means: extracted memories, playbooks, conversation transcripts, source
code, code-derived indexes, embeddings of any of these, and inference traffic
(prompts and completions). The guarantee is achieved by architecture, not
policy: content either never leaves the developer's machine, or leaves it only
as ciphertext the server holds no key for.

This is 1Password's model taken seriously: the server is blind because nothing
intelligent happens there. All memory intelligence — retrieval, embedding,
extraction, compaction, hygiene — runs client-side over locally decrypted data.
The server's entire tenant surface is four jobs: **auth, wrapped-key
distribution, ciphertext sync, and blind coordination** (sync cursors,
tombstones, content-free leases).

## 2. Adversary Model

### In scope (the guarantee holds against)

| Adversary | Why the guarantee holds |
|---|---|
| Honest-but-curious operator | Server stores only ciphertext envelopes and content-free metadata; no decryption keys exist server-side. |
| Fully compromised server infrastructure | Same as above — an attacker with root on the server obtains what the operator has: ciphertext, key-wrapping ciphertext, and metadata. |
| Legal compulsion (subpoena) of the operator | The operator can only produce what it holds. Content is not among it. |
| Cross-tenant access | Org data keys are per-org; a member of org A holds no key material for org B. (Defense in depth: DB-level row scoping from MIM-69 remains.) |

### Out of scope (explicitly not defended)

| Threat | Posture |
|---|---|
| Compromised developer device | The local replica is plaintext (§4). A compromised device also holds the source code, provider API keys, and an authenticated session — memory is not the crown jewel on that machine. Device security is the developer's/OS's job. |
| Malicious org member | Any member holds the org data key by design — sharing is the feature. Removal = key rotation (§5). |
| Malicious client update | Universal E2E caveat: the operator ships the client. Mitigations: the clients are open source; releases are signed. A user who cannot trust the client binary cannot be helped by any E2E design. |
| Inference/embedding provider visibility | Users send prompts to their chosen model provider on their own keys (BYOK). Trusting the provider is inherent to using it. Embeddings are computed locally (§6) and are not exposed to any third party. |
| Traffic metadata | See §7 — accepted residual. |

## 3. Data Classification

| Class | Examples | Where it lives | Server sees |
|---|---|---|---|
| **Synced content** | Extracted memories, playbooks | Plaintext in the local replica; AEAD envelopes on the server | Ciphertext + envelope metadata only |
| **Never leaves the machine** | Conversation transcripts, message logs, source code, Cartographer indexes, embedding vectors | Local only | Nothing |
| **Content-free coordination** | Sync cursors, tombstones, version counters, hygiene leases | Server | Everything (it is content-free by construction) |
| **Identity** | Better Auth users, org membership, wrapped keys | Server | Identities and membership graph (accepted residual, §7); key material only in wrapped (ciphertext) form |

Two classifications deserve their reasoning stated:

**Conversations are not synced content — they are deleted from the server
model, not encrypted.** A conversation is a personal, per-machine artifact. The
org-shared artifact is the *extracted memory*, never the transcript it came
from. Compaction runs locally over a local log.

**Cartographer indexes never sync.** The index is a derived cache of files
already on the developer's disk; a new machine rebuilds it. The most sensitive
data category (code) exits the server with zero cryptography.

## 4. The Plaintext-Local Replica

The local replica (SQLite, per org) stores memories and playbooks **in
plaintext** with ordinary FTS and vector indexes. This is a deliberate,
coherent choice, not a compromise:

- The developer's source code — strictly more sensitive than anything extracted
  from it — sits unencrypted on the same disk.
- It confines all cryptography to **exactly one seam**: the sync module
  encrypts on push and decrypts on pull. Brain code (retrieval, FTS,
  extraction, hygiene) never touches a cipher. No searchable encryption, no
  encrypted-index schemes, no key material threaded through query paths.
- The seam is small, auditable, and testable; it is also where the self-hosted
  plaintext toggle lives (§9).

## 5. Key Hierarchy

All asymmetric material is X25519 (natively supported by Bun's `node:crypto`
— verified: keygen + `diffieHellman` on Bun 1.3.14). All symmetric material
is 256-bit. Schema columns already exist (Better Auth `additionalFields`,
`packages/server/src/auth/instance.ts`).

```
device secret (per user, held per device in the OS credential store)
  └─ HKDF → keyset-encryption key → decrypts the ENCRYPTED KEYSET
       user.encryptedKeyset ─────────────── stored on user record (server, ciphertext)
       keyset = user X25519 private key; public half on user record (server, public)
  └─ private key unwraps → org KEYRING (all live key generations)
       wrapped per member to their public key ── member.wrappedOrgKey (server, ciphertext)
  └─ current-generation org key encrypts → envelope payloads (§6)

org recovery keyset (opt-in; default ON multi-member, OFF solo)
  organization.recoveryPublicKey (server, public)
  organization.wrappedRecoveryKey (server, ciphertext — keyring wrapped to recovery key)
```

**The encrypted keyset is stored server-side** — the direct analog of
1Password's encrypted keyset. The server holds it but cannot open it (the
device secret never leaves the client), and a new device needs only the
password-manager copy of the device secret: pull the encrypted keyset,
decrypt locally, done. **Wraps carry the whole keyring** — every live key
generation — so one unwrap reads a mixed-generation store during rotation
rollover; the re-encrypt push (sync ticket) prunes retired generations.

**Device secret storage:** `Bun.secrets` — the OS credential store (macOS
Keychain Services, Linux libsecret, Windows Credential Manager). Encrypted at
rest under the user's login credentials: a stolen disk or copied home
directory yields nothing. This closes the gap to 1Password's two-secret key
derivation to a documented divergence (§8). The API is experimental, so it is
wrapped in a thin device-secret provider module, which also hosts the
**fallback: a passphrase-encrypted keyfile** for keychain-less environments
(headless Linux without a secret-service daemon). On generation, the client
actively prompts the user to persist a copy to their password manager.

**Wrapping construction:** X25519 ECDH → HKDF-SHA-256 → AEAD (suite of §6).
Ephemeral sender keys for invite wrapping (sealed-box shape). All wrapping and
unwrapping happens client-side; the server stores and relays ciphertext only.

**Invites:** the invitee's client generates a keypair and posts the public
half; an existing member's client wraps the org data key to it. Accepted
latency: the new member cannot decrypt until an existing member's client comes
online. 1Password has the same property.

**Revocation = rotation:** removing a member rotates the org data key to a new
**key generation**; a client re-encrypts the org store under the new
generation and pushes (thousands of blobs — seconds of client work). Envelopes
carry their generation (§6), so mixed-generation stores read cleanly during
rollover. Rotation is routine, not an emergency procedure.

**Recovery:** the recovery keyset is an additional wrap target under the same
construction. Opt-in; solo orgs default to none — a solo developer who loses
the device secret and the password-manager copy loses the synced store (the
local replica survives and can re-seed after re-keying).

## 6. Ciphertext Envelope — Format v1 (frozen)

The envelope is the only shape the server ever stores for tenant content. The
server may index **envelope fields**; it never indexes, parses, or logs the
payload.

| Field | Type | Server may index | Notes |
|---|---|---|---|
| `id` | string (record id) | yes | Client-generated, stable across edits |
| `org_id` | string | yes | Tenant scope; matches row-level PERMISSIONS |
| `kind` | uint8 | yes | 0x01 memory, 0x02 playbook (closed set; extend by spec revision) |
| `envelope_v` | uint8 | yes | Format version; this document defines `1` |
| `suite` | uint8 | yes | Cipher suite. `0x01` = AES-256-GCM. `0x02` reserved (XChaCha20-Poly1305), `0x03` reserved (AEGIS-256) |
| `key_gen` | uint32 | yes | Org key generation that encrypted this payload |
| `version` | uint64 | yes | LWW conflict counter (client Lamport-ish; ties broken by `updated_at`, then `id`) |
| `tombstone` | bool | yes | Deletion marker; payload empty when set |
| `updated_at` | timestamp | yes | Server-assigned on accept (client clocks untrusted) |
| `nonce` | bytes(12) | opaque | Fresh `randomBytes(12)` per encryption, never reused, never derived |
| `payload` | bytes | **never** | AEAD ciphertext ‖ 16-byte tag |

**Suite 0x01 — AES-256-GCM** via Bun-native `node:crypto` (BoringSSL,
hardware-accelerated, zero dependencies). Chosen after probing the runtime:
Bun 1.3.14 exposes no ChaCha20-Poly1305, GCM-SIV, or AEGIS through
`node:crypto`, and a pure-TS or WASM cipher dependency is not justified when
the native cipher is sufficient (see nonce analysis below). The `suite` byte
plus routine rotation (§5) makes migrating to a stronger AEAD a
re-encryption, not a format break.

**AAD binding (mandatory):** the AEAD's additional authenticated data is the
canonical encoding of `envelope_v ‖ suite ‖ kind ‖ id ‖ org_id ‖ key_gen`.
Consequence: a server (or any middlebox) that transplants a ciphertext onto a
different record, org, kind, or generation produces an authentication failure
on the client. The server cannot undetectably reshuffle what it stores.

**Nonce policy:** 96-bit random nonce per encryption, generated inside the
sync seam, never cached, never counter-derived. Collision analysis at our
scale: 10⁷ encryptions under one key generation gives collision probability
≈ 2⁻⁵⁰; NIST's 2³² random-nonce bound is orders of magnitude above per-org
volumes (thousands of records), and every rotation resets the count. The sync
seam carries a regression test asserting nonce freshness per call — the
implementation-bug risk, not the math, is the real exposure, and it is
confined to one audited module.

**LWW semantics:** highest `version` wins; deletes are tombstones and win like
writes; hygiene merges express as delete + delete + create (no special merge
records). Tombstones are GC'd server-side after every org member's cursor has
passed them.

## 7. Residual Exposure (accepted, stated plainly)

The operator, and anyone who compromises or compels the operator, can observe:

- account identities (emails) and the org membership graph
- per-org record counts, envelope sizes, and `kind` distribution
- write/sync timing and frequency patterns
- client IP addresses
- key-generation bumps (i.e., *that* a rotation/revocation happened, not why)

This is metadata, not content. 1Password lives with the equivalent set and
says so; so do we. **Blind to content, not to metadata.** No padding or
size-bucketing scheme is attempted in v1 — envelope sizes are small and
low-variance (memory-sized text), and the added complexity buys little against
the realistic adversary.

## 8. Divergences from 1Password (honest accounting)

| 1Password | Mimir | Assessment |
|---|---|---|
| Two-secret key derivation (memorized password × Secret Key) — a stolen device file alone opens nothing | Single device secret in the OS credential store, encrypted under OS login credentials | Same protection *class* delivered by the OS instead of a custom KDF ceremony. A stolen disk yields nothing in either model. Weaker only if the OS account itself is compromised — at which point the plaintext replica (§4) is exposed anyway, so the marginal loss is nil. |
| SRP authentication (password never transits) | Better Auth sessions/API keys | Acceptable: Mimir's data confidentiality never depends on an auth secret. Auth compromise yields ciphertext. |
| Closed-source clients, audited | Open-source clients, signed releases | Stronger on inspectability; the malicious-update caveat (§2) is shared by both. |

## 9. Self-Hosted Mode

One codebase, one brain, one seam. The client brain runs identically against a
cloud server or a self-hosted one. The **only** divergence is a toggle at the
sync seam: encrypted envelopes (cloud, default) or plaintext envelopes
(self-hosted opt-in, for people who own their server and want debuggability).
Self-hosted single-user skips key ceremony entirely. Forking brain behavior
per deployment mode is forbidden — it is how a project ends up maintaining two
products.

## 10. Implementation Constraints

- Crypto lives **only** in the sync seam module. Nothing else imports cipher
  primitives. (Enforceable by lint/grep; violations are architecture bugs.)
- Primitives are Bun-native `node:crypto` only (AES-256-GCM, X25519, HKDF,
  `randomBytes`). No native-compiled dependencies; no WASM crypto in v1.
- `Bun.secrets` is accessed only through the device-secret provider module
  (experimental-API churn containment + fallback host). The keychain-less
  fallback is a passphrase-encrypted file (`~/.mimir/device-secret.enc`,
  scrypt → AES-256-GCM) with the passphrase supplied via
  `MIMIR_KEY_PASSPHRASE`.
- Secrets a human must hold (device secret at generation, recovery private
  key at setup) are printed exactly once by the explicit `mimir keys`
  ceremonies and never logged; silent boot reconciliation never mints them.
- The seam ships with: nonce-freshness test, AAD-tamper test (transplanted
  ciphertext must fail), key-generation rollover test, LWW convergence test.
- macOS note for the install story: keychain ACLs bind to the `bun` binary;
  a Bun upgrade re-prompts once.

## 11. Migration & Format Evolution

Alpha-era plaintext server data migrates via one final sanctioned read: a
member's client pulls plaintext, encrypts under the org key, re-embeds locally
(the local embedder replaces Cohere vectors regardless), pushes envelopes;
the server then drops plaintext tenant tables (MIM-92). Migration cost scales
with org count — **flip before orgs multiply.**

Format evolution: `envelope_v` governs structure; `suite` governs the AEAD;
`key_gen` + routine rotation make either migration a background re-encrypt.
No flag day is ever required.
