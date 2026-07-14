/**
 * MIM-87 flow tests: full key lifecycles against an in-memory fake of
 * the /v1/keys relay + better-auth update-user, with REAL crypto — the
 * fake mirrors the route semantics pinned by the server-side suite
 * (packages/server/src/routes/keys.test.ts), so these tests exercise the
 * wrap/unwrap integration the server can never see into.
 */

import { describe, expect, test } from "bun:test";

import type { Fetcher } from "./client";
import type { SecretStore } from "./device-secret";
import {
  adoptDeviceSecret,
  ensureOrgKey,
  getOrgKeyring,
  reconcileKeys,
  recoverAccess,
  registerKeys,
  revokeOrgMember,
  resolveKeyset,
  rotateOrgKey,
  setupRecovery,
} from "./flows";

const SERVER = "https://mimir.test.local";

type FakeMember = {
  memberId: string;
  userId: string;
  email: string;
  publicKey: string | null;
  encryptedKeyset: string | null;
  wrappedOrgKey: string | null;
};

/** One org, N members, route semantics matching the server suite. */
function fakeOrg() {
  const org = {
    keyGeneration: null as number | null,
    recoveryPublicKey: null as string | null,
    wrappedRecoveryKey: null as string | null,
  };
  const members: FakeMember[] = [];

  const addMember = (userId: string, email: string) => {
    members.push({
      memberId: `member-${userId}`,
      userId,
      email,
      publicKey: null,
      encryptedKeyset: null,
      wrappedOrgKey: null,
    });
  };

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status });

  const fetcherFor = (userId: string): Fetcher => {
    return async (input, init) => {
      const path = new URL(input).pathname;
      const body: Record<string, unknown> = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      const self = members.find((m) => m.userId === userId);
      if (!self) return json({ error: "Forbidden" }, 403);

      if (path === "/v1/keys/org") {
        return json({
          initialized:
            org.keyGeneration !== null ||
            members.some((m) => m.wrappedOrgKey !== null),
          keyGeneration: org.keyGeneration,
          recoveryPublicKey: org.recoveryPublicKey,
          wrappedRecoveryKey: org.wrappedRecoveryKey,
          self: {
            memberId: self.memberId,
            userId: self.userId,
            publicKey: self.publicKey,
            encryptedKeyset: self.encryptedKeyset,
            wrappedOrgKey: self.wrappedOrgKey,
          },
          members: members.map((m) => ({
            memberId: m.memberId,
            userId: m.userId,
            email: m.email,
            publicKey: m.publicKey,
            hasWrap: m.wrappedOrgKey !== null,
          })),
        });
      }
      if (path === "/api/auth/update-user") {
        self.publicKey = String(body.publicKey);
        self.encryptedKeyset = String(body.encryptedKeyset);
        return json({ status: true });
      }
      if (path === "/v1/keys/init") {
        if (
          org.keyGeneration !== null ||
          members.some((m) => m.wrappedOrgKey !== null)
        ) {
          return json({ error: "Conflict" }, 409);
        }
        self.wrappedOrgKey = String(body.wrappedOrgKey);
        org.keyGeneration = 1;
        return json({ ok: true, keyGeneration: 1 });
      }
      if (path === "/v1/keys/wrap") {
        const target = members.find((m) => m.memberId === body.memberId);
        if (!target) return json({ error: "Not found" }, 404);
        const selfTarget = target.memberId === self.memberId;
        if (!selfTarget && self.wrappedOrgKey === null) {
          return json({ error: "Forbidden" }, 403);
        }
        if (target.wrappedOrgKey !== null && !selfTarget) {
          return json({ error: "Conflict" }, 409);
        }
        target.wrappedOrgKey = String(body.wrappedOrgKey);
        return json({ ok: true });
      }
      if (path === "/v1/keys/rotate") {
        if (self.wrappedOrgKey === null) return json({ error: "Forbidden" }, 403);
        const generation = Number(body.keyGeneration);
        if (generation !== (org.keyGeneration ?? 0) + 1) {
          return json({ error: "Conflict" }, 409);
        }
        const wraps = body.wraps as Array<{
          memberId: string;
          wrappedOrgKey: string;
        }>;
        const removeMemberId =
          typeof body.removeMemberId === "string" ? body.removeMemberId : null;
        if (
          removeMemberId &&
          !members.some((member) => member.memberId === removeMemberId)
        ) {
          return json({ error: "Not found" }, 404);
        }
        const remainingKeyed = members.filter(
          (member) =>
            member.publicKey !== null && member.memberId !== removeMemberId,
        );
        if (
          wraps.length !== remainingKeyed.length ||
          remainingKeyed.some(
            (member) =>
              !wraps.some((wrap) => wrap.memberId === member.memberId),
          )
        ) {
          return json({ error: "Every remaining member needs a wrap" }, 400);
        }
        const recovery = body.recovery as
          | { recoveryPublicKey: string; wrappedRecoveryKey: string }
          | undefined;
        if (org.recoveryPublicKey && !recovery) {
          return json({ error: "Recovery wrap required" }, 409);
        }

        // Everything below this line is the fake's atomic commit.
        for (const member of members) member.wrappedOrgKey = null;
        for (const wrap of wraps) {
          const target = members.find((member) => member.memberId === wrap.memberId);
          if (target) target.wrappedOrgKey = wrap.wrappedOrgKey;
        }
        org.keyGeneration = generation;
        if (recovery) {
          org.recoveryPublicKey = recovery.recoveryPublicKey;
          org.wrappedRecoveryKey = recovery.wrappedRecoveryKey;
        }
        if (removeMemberId) {
          const index = members.findIndex(
            (member) => member.memberId === removeMemberId,
          );
          members.splice(index, 1);
        }
        return json({ ok: true, keyGeneration: generation });
      }
      if (path === "/v1/keys/recovery") {
        if (self.wrappedOrgKey === null) return json({ error: "Forbidden" }, 403);
        org.recoveryPublicKey = String(body.recoveryPublicKey);
        org.wrappedRecoveryKey = String(body.wrappedRecoveryKey);
        return json({ ok: true });
      }
      return json({ error: "Not found" }, 404);
    };
  };

  return { org, members, addMember, fetcherFor };
}

const memoryStore = () => {
  const entries = new Map<string, string>();
  return {
    get: async (name: string) => entries.get(name) ?? null,
    set: async (name: string, value: string) => {
      entries.set(name, value);
    },
  } satisfies SecretStore;
};

/** A user's device: config + its own secret store. */
const deviceFor = (
  world: ReturnType<typeof fakeOrg>,
  userId: string,
  store = memoryStore(),
) => ({
  serverUrl: SERVER,
  apiKey: `key-${userId}`,
  fetcher: world.fetcherFor(userId),
  store,
});

describe("registration", () => {
  test("registerKeys mints secret + keyset and resolves ready", async () => {
    const world = fakeOrg();
    world.addMember("a", "a@test.local");
    const deviceA = deviceFor(world, "a");
    const registered = await registerKeys(deviceA);
    expect(registered.secretCreated).toBe(true);
    const resolved = await resolveKeyset(deviceA);
    expect(resolved.status).toBe("ready");
  });

  test("unregistered account resolves unregistered; fresh device resolves needs-secret", async () => {
    const world = fakeOrg();
    world.addMember("a", "a@test.local");
    const deviceA = deviceFor(world, "a");
    expect((await resolveKeyset(deviceA)).status).toBe("unregistered");
    await registerKeys(deviceA);
    // Same account, different machine: no local secret.
    const freshDevice = deviceFor(world, "a", memoryStore());
    expect((await resolveKeyset(freshDevice)).status).toBe("needs-secret");
  });

  test("adoptDeviceSecret brings a new device online with the pasted secret", async () => {
    const world = fakeOrg();
    world.addMember("a", "a@test.local");
    const deviceA = deviceFor(world, "a");
    const { deviceSecret } = await registerKeys(deviceA);
    const freshDevice = deviceFor(world, "a", memoryStore());
    const adopted = await adoptDeviceSecret(freshDevice, deviceSecret);
    expect(adopted.keyset.publicKey).toBeString();
    expect((await resolveKeyset(freshDevice)).status).toBe("ready");
  });

  test("wrong pasted secret is rejected before persisting", async () => {
    const world = fakeOrg();
    world.addMember("a", "a@test.local");
    const deviceA = deviceFor(world, "a");
    await registerKeys(deviceA);
    const freshDevice = deviceFor(world, "a", memoryStore());
    const { deviceSecret: otherSecret } = await registerKeys(
      // A different account's secret.
      (() => {
        world.addMember("z", "z@test.local");
        return deviceFor(world, "z");
      })(),
    );
    await expect(
      adoptDeviceSecret(freshDevice, otherSecret),
    ).rejects.toThrow();
    expect((await resolveKeyset(freshDevice)).status).toBe("needs-secret");
  });
});

describe("org key lifecycle", () => {
  test("founding member initializes gen 1 and reads it back", async () => {
    const world = fakeOrg();
    world.addMember("a", "a@test.local");
    const deviceA = deviceFor(world, "a");
    await registerKeys(deviceA);
    const ready = await getOrgKeyring(deviceA);
    expect(ready.status).toBe("ready");
    if (ready.status === "ready") expect(ready.generation).toBe(1);
    expect(world.org.keyGeneration).toBe(1);
  });

  test("invite: reconcile fulfils the pending wrap; both read the same keyring", async () => {
    const world = fakeOrg();
    world.addMember("a", "a@test.local");
    world.addMember("b", "b@test.local");
    const deviceA = deviceFor(world, "a");
    const deviceB = deviceFor(world, "b");
    await registerKeys(deviceA);
    await getOrgKeyring(deviceA); // A initializes gen 1
    await registerKeys(deviceB);

    // B waits on an existing member (documented 1P-parity latency).
    expect((await getOrgKeyring(deviceB)).status).toBe("pending-wrap");

    // A comes online: silent reconcile delivers the wrap.
    const reconciled = await reconcileKeys(deviceA);
    expect(reconciled.status).toBe("ready");
    if (reconciled.status === "ready") {
      expect(reconciled.wrapsDelivered).toBe(1);
      expect(reconciled.wrapFailures).toEqual([]);
    }

    const a = await getOrgKeyring(deviceA);
    const b = await getOrgKeyring(deviceB);
    expect(a.status).toBe("ready");
    expect(b.status).toBe("ready");
    if (a.status === "ready" && b.status === "ready") {
      expect(b.keyring).toEqual(a.keyring);
    }
  });

  test("reconcile reports the owed ceremony instead of minting secrets", async () => {
    const world = fakeOrg();
    world.addMember("a", "a@test.local");
    const deviceA = deviceFor(world, "a");
    expect((await reconcileKeys(deviceA)).status).toBe("needs-setup");
    await registerKeys(deviceA);
    const fresh = deviceFor(world, "a", memoryStore());
    expect((await reconcileKeys(fresh)).status).toBe("needs-secret");
  });

  test("rotation revokes the removed member and preserves old generations", async () => {
    const world = fakeOrg();
    world.addMember("a", "a@test.local");
    world.addMember("b", "b@test.local");
    const deviceA = deviceFor(world, "a");
    const deviceB = deviceFor(world, "b");
    const { keyset: keysetA } = await registerKeys(deviceA);
    await getOrgKeyring(deviceA);
    await registerKeys(deviceB);
    await reconcileKeys(deviceA); // wrap B
    const before = await getOrgKeyring(deviceA);

    expect(world.members.some((member) => member.userId === "b")).toBe(true);
    const rotated = await revokeOrgMember(deviceA, keysetA, "member-b");
    expect(rotated.generation).toBe(2);
    expect(rotated.wrapped).toBe(1); // only A remains
    expect(world.members.some((member) => member.userId === "b")).toBe(false);

    const after = await getOrgKeyring(deviceA);
    expect(after.status).toBe("ready");
    if (after.status === "ready" && before.status === "ready") {
      expect(after.generation).toBe(2);
      // Gen-1 key retained for mixed-generation rollover reads.
      expect(after.keyring.keys["1"]).toEqual(before.keyring.keys["1"]);
      expect(after.keyring.keys["2"]).toBeString();
    }
  });
});

describe("recovery", () => {
  test("recovery keyset round-trips a locked-out member back in", async () => {
    const world = fakeOrg();
    world.addMember("a", "a@test.local");
    const deviceA = deviceFor(world, "a");
    const { keyset: keysetA } = await registerKeys(deviceA);
    const before = await getOrgKeyring(deviceA);

    const recovery = await setupRecovery(deviceA, keysetA);
    expect(world.org.recoveryPublicKey).toBe(recovery.recoveryPublicKey);

    // Catastrophe: A loses the device secret AND the password-manager
    // copy — new empty device, old keyset unreadable.
    const wreckedDevice = deviceFor(world, "a", memoryStore());
    expect((await getOrgKeyring(wreckedDevice)).status).toBe("needs-secret");

    const recovered = await recoverAccess(
      wreckedDevice,
      recovery.recoveryPrivateKey,
    );
    expect(recovered.secretCreated).toBe(true);
    const after = await getOrgKeyring(wreckedDevice);
    expect(after.status).toBe("ready");
    if (after.status === "ready" && before.status === "ready") {
      expect(after.keyring).toEqual(before.keyring);
    }
  });

  test("recoverAccess without a configured keyset fails loudly", async () => {
    const world = fakeOrg();
    world.addMember("a", "a@test.local");
    const deviceA = deviceFor(world, "a");
    await registerKeys(deviceA);
    await getOrgKeyring(deviceA);
    await expect(
      recoverAccess(deviceA, "bm90LWEtcmVhbC1rZXk"),
    ).rejects.toThrow("no recovery keyset");
  });

  test("rotation refreshes the recovery wrap", async () => {
    const world = fakeOrg();
    world.addMember("a", "a@test.local");
    const deviceA = deviceFor(world, "a");
    const { keyset: keysetA } = await registerKeys(deviceA);
    await getOrgKeyring(deviceA);
    const recovery = await setupRecovery(deviceA, keysetA);
    const wrapBefore = world.org.wrappedRecoveryKey;

    await rotateOrgKey(deviceA, keysetA);
    expect(world.org.wrappedRecoveryKey).not.toBe(wrapBefore);

    // The recovery key can still open the post-rotation keyring.
    const wreckedDevice = deviceFor(world, "a", memoryStore());
    const recovered = await recoverAccess(
      wreckedDevice,
      recovery.recoveryPrivateKey,
    );
    expect(Object.keys(recovered.keyring.keys).sort()).toEqual(["1", "2"]);
  });
});

describe("ensureOrgKey race", () => {
  test("losing the founding race falls through gracefully (409, no forked key)", async () => {
    const world = fakeOrg();
    world.addMember("a", "a@test.local");
    world.addMember("b", "b@test.local");
    const deviceA = deviceFor(world, "a");
    const deviceB = deviceFor(world, "b");
    const { keyset: keysetA } = await registerKeys(deviceA);
    const { keyset: keysetB } = await registerKeys(deviceB);

    // B snapshots the org state while it is still uninitialized…
    const staleForB = await resolveKeyset(deviceB);
    if (staleForB.status !== "ready") throw new Error("B should be ready");
    expect(staleForB.state.initialized).toBe(false);

    // …then A wins the founding race.
    const a = await ensureOrgKey(deviceA, keysetA);
    expect(a.status).toBe("ready");

    // B's init hits the CAS 409, re-fetches, and lands on pending-wrap —
    // the org key is NOT forked.
    const b = await ensureOrgKey(deviceB, keysetB, staleForB.state);
    expect(b.status).toBe("pending-wrap");
    expect(world.org.keyGeneration).toBe(1);
  });
});
