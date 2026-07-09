/**
 * MIM-88 sync engine: two-client convergence over a fake relay with the
 * REAL crypto stack (keys flows + envelope seam + replica spine). The
 * fake mirrors the server suites' pinned semantics for /v1/keys/* and
 * /v1/sync/* — what these tests add is the end-to-end property the
 * server can never verify itself: plaintext in one replica, ciphertext
 * on the wire, identical plaintext in the other replica.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Fetcher } from "../keys/client";
import type { SecretStore } from "../keys/device-secret";
import { getOrgKeyring, registerKeys, reconcileKeys, rotateOrgKey, resolveKeyset } from "../keys/flows";
import { createOrgReplica } from "../store/org-replica";
import { syncOrg } from "./engine";

const SERVER = "https://sync.test.local";

type FakeMember = {
  memberId: string;
  userId: string;
  email: string;
  publicKey: string | null;
  encryptedKeyset: string | null;
  wrappedOrgKey: string | null;
};

type StoredEnvelope = Record<string, unknown> & {
  seq: number;
  id: string;
  version: number;
};

/** One org world: MIM-87 key relay + MIM-88 sync relay, LWW semantics
 *  matching the server suite. Keyless callers scope to "owner". */
function fakeWorld() {
  const org = { keyGeneration: null as number | null };
  const members: FakeMember[] = [];
  const envelopes = new Map<string, StoredEnvelope>(); // by orgId:id
  let seq = 0;

  const addMember = (userId: string) => {
    members.push({
      memberId: `member-${userId}`,
      userId,
      email: `${userId}@test.local`,
      publicKey: null,
      encryptedKeyset: null,
      wrappedOrgKey: null,
    });
  };

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status });

  const fetcherFor = (userId: string | null): Fetcher => {
    return async (input, init) => {
      const url = new URL(input);
      const path = url.pathname;
      const body: Record<string, unknown> = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      const self = userId ? members.find((m) => m.userId === userId) : null;
      const orgId = userId ? "org-1" : "owner";

      // ── MIM-87 key relay ──
      if (path === "/v1/keys/org") {
        if (!self) return json({ error: "Forbidden" }, 403);
        return json({
          initialized: org.keyGeneration !== null,
          keyGeneration: org.keyGeneration,
          recoveryPublicKey: null,
          wrappedRecoveryKey: null,
          self: { ...self },
          members: members.map((m) => ({
            memberId: m.memberId,
            userId: m.userId,
            email: m.email,
            publicKey: m.publicKey,
            hasWrap: m.wrappedOrgKey !== null,
          })),
        });
      }
      if (path === "/api/auth/update-user" && self) {
        self.publicKey = String(body.publicKey);
        self.encryptedKeyset = String(body.encryptedKeyset);
        return json({ status: true });
      }
      if (path === "/v1/keys/init" && self) {
        if (org.keyGeneration !== null) return json({ error: "Conflict" }, 409);
        self.wrappedOrgKey = String(body.wrappedOrgKey);
        org.keyGeneration = 1;
        return json({ ok: true });
      }
      if (path === "/v1/keys/wrap" && self) {
        const target = members.find((m) => m.memberId === body.memberId);
        if (!target) return json({ error: "Not found" }, 404);
        if (target.wrappedOrgKey && target.memberId !== self.memberId) {
          return json({ error: "Conflict" }, 409);
        }
        target.wrappedOrgKey = String(body.wrappedOrgKey);
        return json({ ok: true });
      }
      if (path === "/v1/keys/rotate" && self) {
        const wraps = body.wraps as Array<{ memberId: string; wrappedOrgKey: string }>;
        for (const m of members) m.wrappedOrgKey = null;
        for (const wrap of wraps) {
          const target = members.find((m) => m.memberId === wrap.memberId);
          if (target) target.wrappedOrgKey = wrap.wrappedOrgKey;
        }
        org.keyGeneration = Number(body.keyGeneration);
        return json({ ok: true });
      }

      // ── MIM-88 sync relay ──
      if (path === "/v1/sync/push") {
        const incoming = body.envelopes as Array<Record<string, unknown>>;
        let accepted = 0;
        const stale: string[] = [];
        for (const envelope of incoming) {
          const key = `${orgId}:${envelope.id}`;
          const stored = envelopes.get(key);
          if (stored && stored.version > Number(envelope.version)) {
            stale.push(String(envelope.id));
            continue;
          }
          seq += 1;
          envelopes.set(key, {
            ...envelope,
            seq,
            id: String(envelope.id),
            version: Number(envelope.version),
          });
          accepted += 1;
        }
        return json({ accepted, stale, cursor: seq });
      }
      if (path === "/v1/sync/pull") {
        const since = Number(url.searchParams.get("since") ?? "0");
        const rows = [...envelopes.entries()]
          .filter(([key, e]) => key.startsWith(`${orgId}:`) && e.seq > since)
          .map(([, e]) => e)
          .sort((a, b) => a.seq - b.seq);
        const last = rows[rows.length - 1];
        return json({
          orgId,
          envelopes: rows.map(({ seq: _seq, ...wire }) => wire),
          nextCursor: last ? last.seq : since,
        });
      }
      return json({ error: "Not found" }, 404);
    };
  };

  /** Raw wire payloads for blindness assertions. */
  const rawPayloads = () =>
    [...envelopes.values()].map((e) => String(e.payload));

  return { addMember, fetcherFor, rawPayloads, org };
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

const freshReplica = () =>
  createOrgReplica(
    join(mkdtempSync(join(tmpdir(), "mimir-engine-")), "replica.db"),
  );

/** A user's device: keys config + own replica + own secret store. */
const deviceFor = (world: ReturnType<typeof fakeWorld>, userId: string) => ({
  serverUrl: SERVER,
  apiKey: `key-${userId}`,
  fetcher: world.fetcherFor(userId),
  store: memoryStore(),
  replica: freshReplica(),
});

/** Register + unlock the org key for a device (founding or invited). */
const bringOnline = async (device: ReturnType<typeof deviceFor>) => {
  await registerKeys(device);
  return getOrgKeyring(device);
};

describe("encrypted two-client convergence", () => {
  test("plaintext in, ciphertext on the wire, plaintext out", async () => {
    const world = fakeWorld();
    world.addMember("a");
    world.addMember("b");
    const deviceA = deviceFor(world, "a");
    const deviceB = deviceFor(world, "b");
    await bringOnline(deviceA); // founds gen 1
    await bringOnline(deviceB); // pending
    await reconcileKeys(deviceA); // wraps B

    deviceA.replica.storeMemory({ content: "the forge runs hot tonight" });
    deviceA.replica.storeMemory({
      content: "playbook: how to temper a blade",
      type: "playbook",
      name: "temper-blade",
      trigger: "tempering",
    });

    const up = await syncOrg(deviceA);
    expect(up.status).toBe("synced");
    if (up.status === "synced") {
      expect(up.mode).toBe("keyring");
      expect(up.pushed).toBe(2);
    }

    // Operator-blindness at the wire: no plaintext in any stored payload.
    for (const payload of world.rawPayloads()) {
      const decoded = Buffer.from(payload, "base64url").toString("utf8");
      expect(decoded).not.toContain("forge");
      expect(decoded).not.toContain("temper");
    }

    const down = await syncOrg(deviceB);
    expect(down.status).toBe("synced");
    if (down.status === "synced") {
      expect(down.applied).toBe(2);
      expect(down.openFailures).toEqual([]);
    }
    const contents = deviceB.replica.listMemories().map((m) => m.content);
    expect(contents).toContain("the forge runs hot tonight");
    // Pulled rows arrive unembedded (vectors never sync).
    expect(deviceB.replica.listUnembedded().length).toBe(2);
  });

  test("edits and tombstones propagate", async () => {
    const world = fakeWorld();
    world.addMember("a");
    world.addMember("b");
    const deviceA = deviceFor(world, "a");
    const deviceB = deviceFor(world, "b");
    await bringOnline(deviceA);
    await bringOnline(deviceB);
    await reconcileKeys(deviceA);

    const keepId = deviceA.replica.storeMemory({ content: "keep and edit me" });
    const doomId = deviceA.replica.storeMemory({ content: "delete me soon" });
    await syncOrg(deviceA);
    await syncOrg(deviceB);
    expect(deviceB.replica.countMemories()).toBe(2);

    // B edits one and deletes the other; A pulls both changes.
    deviceB.replica.updateMemory(keepId, "edited by B");
    deviceB.replica.deleteMemory(doomId);
    await syncOrg(deviceB);
    const result = await syncOrg(deviceA);
    expect(result.status).toBe("synced");
    expect(deviceA.replica.getMemory(keepId)?.content).toBe("edited by B");
    expect(deviceA.replica.getMemory(doomId)).toBeNull();
    expect(deviceA.replica.countMemories()).toBe(1);
  });

  test("concurrent conflicting edits converge on the winner", async () => {
    const world = fakeWorld();
    world.addMember("a");
    world.addMember("b");
    const deviceA = deviceFor(world, "a");
    const deviceB = deviceFor(world, "b");
    await bringOnline(deviceA);
    await bringOnline(deviceB);
    await reconcileKeys(deviceA);

    const id = deviceA.replica.storeMemory({ content: "base fact" });
    await syncOrg(deviceA);
    await syncOrg(deviceB);

    // Both edit offline from version 1 → both at version 2.
    deviceA.replica.updateMemory(id, "A's take");
    deviceB.replica.updateMemory(id, "B's take");
    await syncOrg(deviceA); // A lands version 2 first
    await syncOrg(deviceB); // B's equal version lands later → LWW winner
    await syncOrg(deviceA); // A pulls the winner

    expect(deviceA.replica.getMemory(id)?.content).toBe("B's take");
    expect(deviceB.replica.getMemory(id)?.content).toBe("B's take");
  });

  test("rotation mid-stream: gen-1 and gen-2 envelopes both readable", async () => {
    const world = fakeWorld();
    world.addMember("a");
    world.addMember("b");
    const deviceA = deviceFor(world, "a");
    const deviceB = deviceFor(world, "b");
    await bringOnline(deviceA);
    await bringOnline(deviceB);
    await reconcileKeys(deviceA);

    deviceA.replica.storeMemory({ content: "sealed at generation one" });
    await syncOrg(deviceA);

    // Rotate (both members re-wrapped by the flow), then write more.
    const resolvedA = await resolveKeyset(deviceA);
    if (resolvedA.status !== "ready") throw new Error("A not ready");
    await rotateOrgKey(deviceA, resolvedA.keyset);
    expect(world.org.keyGeneration).toBe(2);
    deviceA.replica.storeMemory({ content: "sealed at generation two" });
    await syncOrg(deviceA);

    // B re-pulls its wrap inside syncOrg → keyring carries gens 1+2.
    const down = await syncOrg(deviceB);
    expect(down.status).toBe("synced");
    if (down.status === "synced") expect(down.openFailures).toEqual([]);
    const contents = deviceB.replica.listMemories().map((m) => m.content);
    expect(contents).toContain("sealed at generation one");
    expect(contents).toContain("sealed at generation two");
  });

  test("keys not ready → sync skips, never plaintexts an authed org", async () => {
    const world = fakeWorld();
    world.addMember("a");
    world.addMember("b");
    const deviceA = deviceFor(world, "a");
    const deviceB = deviceFor(world, "b");
    await bringOnline(deviceA);
    await bringOnline(deviceB); // B pending — no wrap delivered yet

    deviceB.replica.storeMemory({ content: "must not leak plaintext" });
    const result = await syncOrg(deviceB);
    expect(result.status).toBe("keys-not-ready");
    expect(world.rawPayloads()).toHaveLength(0);
  });
});

describe("plaintext self-hosted mode", () => {
  test("keyless devices sync suite-0 envelopes with no ceremony", async () => {
    const world = fakeWorld();
    const deviceA = {
      serverUrl: SERVER,
      fetcher: world.fetcherFor(null),
      replica: freshReplica(),
    };
    const deviceB = {
      serverUrl: SERVER,
      fetcher: world.fetcherFor(null),
      replica: freshReplica(),
    };
    deviceA.replica.storeMemory({ content: "homelab wisdom" });
    const up = await syncOrg(deviceA);
    expect(up.status).toBe("synced");
    if (up.status === "synced") expect(up.mode).toBe("plaintext");

    const down = await syncOrg(deviceB);
    expect(down.status).toBe("synced");
    expect(deviceB.replica.listMemories()[0]?.content).toBe("homelab wisdom");
  });
});
