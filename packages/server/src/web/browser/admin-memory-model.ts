import {
  KIND_MEMORY,
  KIND_PLAYBOOK,
  PAGE_SIZE,
  parseMemoryPayload,
  type WireEnvelope,
} from "./memory-model";

const MAX_ID_LENGTH = 256;
const MAX_NONCE_LENGTH = 128;
const MAX_PAYLOAD_LENGTH = 1_500_000;
const MAX_KEY_GENERATION = 0xffff_ffff;
const BASE64URL = /^[A-Za-z0-9_-]*$/;

export type ManagedMemory = ReturnType<typeof parseMemoryPayload> & {
  id: string;
  kind: number;
  keyGen: number;
  version: number;
  syncState: "conflict" | "synced";
};

export type AdminMemoryFilters = {
  query: string;
  project: string;
  type: string;
  generation: string;
  syncState: string;
  page: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

function parseEnvelope(value: unknown) {
  if (!isRecord(value)) throw new Error("Sync returned a malformed envelope");
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    value.id.length > MAX_ID_LENGTH ||
    (value.kind !== KIND_MEMORY && value.kind !== KIND_PLAYBOOK) ||
    (value.v !== 1 && value.v !== 2) ||
    (value.suite !== 0 && value.suite !== 1) ||
    !Number.isSafeInteger(value.keyGen) ||
    Number(value.keyGen) < 0 ||
    Number(value.keyGen) > MAX_KEY_GENERATION ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1 ||
    typeof value.tombstone !== "boolean" ||
    typeof value.nonce !== "string" ||
    value.nonce.length > MAX_NONCE_LENGTH ||
    !BASE64URL.test(value.nonce) ||
    typeof value.payload !== "string" ||
    value.payload.length > MAX_PAYLOAD_LENGTH ||
    !BASE64URL.test(value.payload)
  ) {
    throw new Error("Sync returned an unsupported envelope");
  }
  if (value.suite === 0 && (value.keyGen !== 0 || value.nonce !== "")) {
    throw new Error("Sync returned an unsupported envelope");
  }
  if (
    value.suite === 1 &&
    !(value.v === 1 && value.tombstone) &&
    (Number(value.keyGen) < 1 ||
      value.nonce.length !== 16 ||
      value.payload.length < 22)
  ) {
    throw new Error("Sync returned an unsupported envelope");
  }
  if (
    value.v === 1 &&
    value.tombstone &&
    (value.nonce !== "" || value.payload !== "")
  ) {
    throw new Error("Sync returned an unsupported envelope");
  }
  if (
    value.v === 2 &&
    value.suite === 0 &&
    value.tombstone &&
    value.payload !== ""
  ) {
    throw new Error("Sync returned an unsupported envelope");
  }
  return {
    id: value.id,
    kind: value.kind,
    v: value.v,
    suite: value.suite,
    keyGen: Number(value.keyGen),
    version: Number(value.version),
    tombstone: value.tombstone,
    nonce: value.nonce,
    payload: value.payload,
  } satisfies WireEnvelope;
}

export function parseAdminPull(value: unknown, expectedOrgId: string) {
  if (!isRecord(value) || value.orgId !== expectedOrgId) {
    throw new Error("Sync returned the wrong organization");
  }
  if (!Array.isArray(value.envelopes) || value.envelopes.length > 500) {
    throw new Error("Sync returned an invalid page");
  }
  if (!Number.isSafeInteger(value.nextCursor) || Number(value.nextCursor) < 0) {
    throw new Error("Sync returned an invalid cursor");
  }
  return {
    envelopes: value.envelopes.map(parseEnvelope),
    nextCursor: Number(value.nextCursor),
  };
}

export function awaitsMigration(envelope: WireEnvelope) {
  return envelope.v !== 2 || envelope.suite !== 1;
}

export function managedMemory(
  envelope: WireEnvelope,
  payload: string,
  conflicted = false,
) {
  return {
    id: envelope.id,
    kind: envelope.kind,
    keyGen: envelope.keyGen,
    version: envelope.version,
    syncState: conflicted ? "conflict" : "synced",
    ...parseMemoryPayload(payload),
  } satisfies ManagedMemory;
}

export function filterManagedMemories(
  memories: Iterable<ManagedMemory>,
  filters: AdminMemoryFilters,
) {
  const query = filters.query.trim().toLocaleLowerCase();
  const generation = filters.generation ? Number(filters.generation) : null;
  const found = Array.from(memories)
    .filter(
      (memory) =>
        (!query ||
          memory.content.toLocaleLowerCase().includes(query) ||
          memory.name?.toLocaleLowerCase().includes(query)) &&
        (!filters.project || memory.projectId === filters.project) &&
        (!filters.type || memory.type === filters.type) &&
        (generation === null || memory.keyGen === generation) &&
        (!filters.syncState || memory.syncState === filters.syncState),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const pages = Math.max(1, Math.ceil(found.length / PAGE_SIZE));
  const page = Math.min(Math.max(filters.page, 1), pages);
  return {
    rows: found.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    total: found.length,
    page,
    pages,
  };
}

export function groupManagedMemories(
  memories: ManagedMemory[],
  groupBy: string,
) {
  const groups = new Map<string, ManagedMemory[]>();
  for (const memory of memories) {
    const label =
      groupBy === "type"
        ? memory.type
        : groupBy === "project"
          ? (memory.projectId ?? "No project")
          : groupBy === "generation"
            ? `Generation ${memory.keyGen}`
            : groupBy === "sync"
              ? memory.syncState
              : "Memories";
    const group = groups.get(label) ?? [];
    group.push(memory);
    groups.set(label, group);
  }
  return groups;
}

export function parseMaintenanceResult(value: unknown, expected: number) {
  if (!isRecord(value) || !Number.isSafeInteger(value.accepted)) return null;
  if (!Array.isArray(value.stale)) return null;
  const stale = value.stale.filter(
    (id): id is string => typeof id === "string" && id.length <= MAX_ID_LENGTH,
  );
  if (stale.length !== value.stale.length) return null;
  return {
    stale,
    complete: Number(value.accepted) === expected && stale.length === 0,
  };
}
