/**
 * Key-distribution flows (MIM-87) — the client-side lifecycle over the
 * crypto primitives and the /v1/keys relay. All wrapping and unwrapping
 * happens here, on the developer's machine; the server only ever sees
 * the ciphertext these flows produce.
 *
 * Two entry classes, deliberately separated:
 *
 * - SILENT (boot reconcile, any plugin): `reconcileKeys` — validates the
 *   local key state, initializes the org key when this client is the
 *   founding member, and fulfils pending wraps for invitees. It NEVER
 *   generates a device secret or keyset: a headless hook cannot show a
 *   human a secret exactly once, so anything that mints a human-held
 *   secret is an explicit CLI ceremony.
 *
 * - EXPLICIT (the `mimir keys` CLI): `registerKeys` (device secret +
 *   keyset generation — the 1P Emergency-Kit moment), `adoptDeviceSecret`
 *   (new device, pasted secret), `rotateOrgKey` / `revokeOrgMember`,
 *   `setupRecovery` / `recoverAccess`.
 *
 * `getOrgKeyring` is the MIM-88 consumer API: sync encrypts/decrypts
 * envelopes with what it returns.
 */

import { attempt } from "../result";
import {
  fetchOrgKeyState,
  isConflict,
  type KeysClientConfig,
  type OrgKeyState,
  postInit,
  postRecovery,
  postRotate,
  postWrap,
  updateUserKeys,
} from "./client";
import { generateKeypair } from "./crypto";
import {
  ensureDeviceSecret,
  getDeviceSecret,
  type SecretStore,
  storeDeviceSecret,
} from "./device-secret";
import {
  appendGeneration,
  createKeyring,
  currentGeneration,
  type Keyring,
  unwrapKeyring,
  wrapKeyring,
} from "./keyring";
import {
  decryptKeyset,
  encryptKeyset,
  generateKeyset,
  type Keyset,
} from "./keyset";

export type KeyFlowConfig = KeysClientConfig & {
  /** Injectable secret store — tests must never touch a real keychain. */
  readonly store?: SecretStore;
};

/**
 * Resolve the local keyset against the server record. Read-only: never
 * generates anything. The statuses map onto the CLI/reconcile guidance:
 * unregistered → run setup; needs-secret → paste from password manager;
 * needs-recovery → keyset unusable, use the org recovery key.
 */
export async function resolveKeyset(cfg: KeyFlowConfig, state?: OrgKeyState) {
  const orgState = state ?? (await fetchOrgKeyState(cfg));
  const { publicKey, encryptedKeyset } = orgState.self;
  if (!publicKey || !encryptedKeyset) {
    return { status: "unregistered", state: orgState } as const;
  }
  const secret = await getDeviceSecret(cfg.serverUrl, cfg.store);
  if (!secret) {
    return { status: "needs-secret", state: orgState } as const;
  }
  const [decryptError, keyset] = await attempt(async () =>
    decryptKeyset(secret, encryptedKeyset),
  );
  if (decryptError) {
    // Wrong secret for this keyset, or a corrupted blob — either way the
    // keyset is unreadable on this device.
    return {
      status: "needs-recovery",
      state: orgState,
      detail: decryptError.message,
    } as const;
  }
  if (keyset.publicKey !== publicKey) {
    return {
      status: "needs-recovery",
      state: orgState,
      detail: "local keyset does not match the registered public key",
    } as const;
  }
  return { status: "ready", keyset, state: orgState } as const;
}

/**
 * EXPLICIT: first-time registration — generates the device secret (when
 * absent) and the keyset, registers both halves with the server. The
 * caller MUST show `deviceSecret` to the user with the persist-to-
 * password-manager prompt when `secretCreated` is true.
 */
export async function registerKeys(cfg: KeyFlowConfig) {
  const { secret, created } = await ensureDeviceSecret(
    cfg.serverUrl,
    cfg.store,
  );
  const keyset = generateKeyset();
  await updateUserKeys(cfg, {
    publicKey: keyset.publicKey,
    encryptedKeyset: encryptKeyset(secret, keyset),
  });
  return { keyset, deviceSecret: secret, secretCreated: created };
}

/** EXPLICIT: new-device flow — validate a pasted device secret against
 *  the server-held encrypted keyset, then persist it locally. */
export async function adoptDeviceSecret(cfg: KeyFlowConfig, secret: string) {
  const state = await fetchOrgKeyState(cfg);
  const encrypted = state.self.encryptedKeyset;
  if (!encrypted) {
    throw new Error("no keyset registered for this account — run setup");
  }
  // Throws on a wrong secret before anything is persisted.
  const keyset = decryptKeyset(secret, encrypted);
  await storeDeviceSecret(cfg.serverUrl, secret, cfg.store);
  return { keyset, state };
}

/**
 * Resolve the org keyring for a ready keyset. Initializes generation 1
 * when the org has no key yet (safe silently: the org key is machine
 * material, recoverable through any keyed member — no human ceremony).
 * An init 409 means another founding member won the race — re-fetch and
 * fall through to the wrapped/pending branches.
 */
export async function ensureOrgKey(
  cfg: KeyFlowConfig,
  keyset: Keyset,
  state?: OrgKeyState,
) {
  let orgState = state ?? (await fetchOrgKeyState(cfg));
  if (!orgState.initialized) {
    const keyring = createKeyring();
    const [initError] = await attempt(() =>
      postInit(cfg, { wrappedOrgKey: wrapKeyring(keyset.publicKey, keyring) }),
    );
    if (!initError) {
      return { status: "ready", keyring, state: orgState } as const;
    }
    if (!isConflict(initError)) throw initError;
    orgState = await fetchOrgKeyState(cfg);
  }
  if (orgState.self.wrappedOrgKey) {
    const keyring = unwrapKeyring(
      keyset.privateKey,
      orgState.self.wrappedOrgKey,
    );
    return { status: "ready", keyring, state: orgState } as const;
  }
  // Invite latency (documented, 1P parity): an existing member's client
  // must come online and wrap the keyring to this member's public key.
  return { status: "pending-wrap", state: orgState } as const;
}

/** Wrap the keyring to every registered, wrap-less member (the invite
 *  fulfilment leg). Per-member failures are collected, not fatal — a 409
 *  just means another client delivered first. */
export async function fulfillPendingWraps(
  cfg: KeyFlowConfig,
  keyring: Keyring,
  state: OrgKeyState,
) {
  const pending = state.members.filter(
    (m) =>
      m.publicKey !== null && !m.hasWrap && m.memberId !== state.self.memberId,
  );
  let delivered = 0;
  const failures: string[] = [];
  for (const member of pending) {
    const publicKey = member.publicKey;
    if (!publicKey) continue;
    const [error] = await attempt(() =>
      postWrap(cfg, {
        memberId: member.memberId,
        wrappedOrgKey: wrapKeyring(publicKey, keyring),
      }),
    );
    if (!error) {
      delivered += 1;
    } else if (!isConflict(error)) {
      failures.push(`${member.email}: ${error.message}`);
    }
  }
  return { delivered, failures };
}

/**
 * EXPLICIT: append generation N+1 and re-wrap every keyed member. When
 * removing a member, omit that member's wrap and ask the server to commit
 * the key rotation and membership deletion in one transaction. Refreshes
 * the recovery wrap when a recovery keyset is configured. MIM-88's
 * re-encrypt job prunes old generations after the store is re-pushed.
 */
export async function rotateOrgKey(
  cfg: KeyFlowConfig,
  keyset: Keyset,
  options?: { removeMemberId?: string },
) {
  const state = await fetchOrgKeyState(cfg);
  if (!state.self.wrappedOrgKey) {
    throw new Error("cannot rotate without holding the current org key");
  }
  const current = unwrapKeyring(keyset.privateKey, state.self.wrappedOrgKey);
  const { keyring, generation } = appendGeneration(current);
  const wraps = state.members.flatMap((m) =>
    m.publicKey && m.memberId !== options?.removeMemberId
      ? [
          {
            memberId: m.memberId,
            wrappedOrgKey: wrapKeyring(m.publicKey, keyring),
          },
        ]
      : [],
  );
  const recovery = state.recoveryPublicKey
    ? {
        recoveryPublicKey: state.recoveryPublicKey,
        wrappedRecoveryKey: wrapKeyring(state.recoveryPublicKey, keyring),
      }
    : undefined;
  await postRotate(cfg, {
    keyGeneration: generation,
    wraps,
    ...(recovery ? { recovery } : {}),
    ...(options?.removeMemberId
      ? { removeMemberId: options.removeMemberId }
      : {}),
  });
  return { generation, wrapped: wraps.length, keyring };
}

/** EXPLICIT: cryptographically revoke a member and remove their live
 *  authorization only if the replacement generation is committed. */
export const revokeOrgMember = (
  cfg: KeyFlowConfig,
  keyset: Keyset,
  memberId: string,
) => rotateOrgKey(cfg, keyset, { removeMemberId: memberId });

/**
 * EXPLICIT: configure the org recovery keyset (1P Recovery Group
 * pattern). Returns the recovery PRIVATE key — the caller shows it
 * exactly once for offline storage; it is never persisted anywhere.
 */
export async function setupRecovery(cfg: KeyFlowConfig, keyset: Keyset) {
  const state = await fetchOrgKeyState(cfg);
  if (!state.self.wrappedOrgKey) {
    throw new Error("cannot configure recovery without the org key");
  }
  const keyring = unwrapKeyring(keyset.privateKey, state.self.wrappedOrgKey);
  const pair = generateKeypair();
  await postRecovery(cfg, {
    recoveryPublicKey: pair.publicKey,
    wrappedRecoveryKey: wrapKeyring(pair.publicKey, keyring),
  });
  return {
    recoveryPrivateKey: pair.privateKey,
    recoveryPublicKey: pair.publicKey,
  };
}

/**
 * EXPLICIT: full re-entry with the org recovery key — lost device secret
 * AND no other keyed device. Mints a fresh device secret + keyset,
 * re-registers, and self-wraps the recovered keyring (the wrap route's
 * self-target exception). Caller shows the new device secret once when
 * `secretCreated` is true.
 */
export async function recoverAccess(
  cfg: KeyFlowConfig,
  recoveryPrivateKey: string,
) {
  const state = await fetchOrgKeyState(cfg);
  if (!state.wrappedRecoveryKey) {
    throw new Error("no recovery keyset configured for this org");
  }
  const keyring = unwrapKeyring(recoveryPrivateKey, state.wrappedRecoveryKey);
  const { secret, created } = await ensureDeviceSecret(
    cfg.serverUrl,
    cfg.store,
  );
  const keyset = generateKeyset();
  await updateUserKeys(cfg, {
    publicKey: keyset.publicKey,
    encryptedKeyset: encryptKeyset(secret, keyset),
  });
  await postWrap(cfg, {
    memberId: state.self.memberId,
    wrappedOrgKey: wrapKeyring(keyset.publicKey, keyring),
  });
  return { keyset, keyring, deviceSecret: secret, secretCreated: created };
}

/** The MIM-88 consumer API: usable org key material, or a status telling
 *  the caller which ceremony is missing. */
export async function getOrgKeyring(cfg: KeyFlowConfig) {
  const resolved = await resolveKeyset(cfg);
  if (resolved.status !== "ready") {
    return { status: resolved.status } as const;
  }
  const org = await ensureOrgKey(cfg, resolved.keyset, resolved.state);
  if (org.status !== "ready") {
    return { status: org.status } as const;
  }
  return {
    status: "ready",
    keyring: org.keyring,
    generation: currentGeneration(org.keyring),
  } as const;
}

/**
 * SILENT boot reconcile — never throws, never mints human-held secrets.
 * Ready clients initialize the org key when absent and fulfil pending
 * wraps; everything else reports the ceremony the user still owes.
 */
export async function reconcileKeys(cfg: KeyFlowConfig) {
  const [resolveError, resolved] = await attempt(() => resolveKeyset(cfg));
  if (resolveError) {
    return { status: "error", detail: resolveError.message } as const;
  }
  if (resolved.status !== "ready") {
    const status =
      resolved.status === "unregistered" ? "needs-setup" : resolved.status;
    return { status } as const;
  }
  const [orgError, org] = await attempt(() =>
    ensureOrgKey(cfg, resolved.keyset, resolved.state),
  );
  if (orgError) return { status: "error", detail: orgError.message } as const;
  if (org.status !== "ready") return { status: org.status } as const;
  const [fulfilError, fulfilment] = await attempt(() =>
    fulfillPendingWraps(cfg, org.keyring, org.state),
  );
  if (fulfilError) {
    return { status: "error", detail: fulfilError.message } as const;
  }
  return {
    status: "ready",
    generation: currentGeneration(org.keyring),
    wrapsDelivered: fulfilment.delivered,
    wrapFailures: fulfilment.failures,
  } as const;
}
