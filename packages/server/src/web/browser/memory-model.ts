export const ENVELOPE_VERSION = 2;
export const SUITE_AES_256_GCM = 1;
export const KIND_MEMORY = 1;
export const KIND_PLAYBOOK = 2;
export const PAGE_SIZE = 20;
const MAX_ID_LENGTH = 256;
const MAX_PAYLOAD_LENGTH = 1_048_576;
const MEMORY_TYPES = new Set(["fact", "summary", "playbook", "skill"]);

export type WireEnvelope = {
  id: string;
  kind: number;
  v: number;
  suite: number;
  keyGen: number;
  version: number;
  tombstone: boolean;
  nonce: string;
  payload: string;
};

export type MemoryRecord = {
  id: string;
  version: number;
  content: string;
  projectId: string | null;
  type: string;
  name: string | null;
  trigger: string | null;
  confidence: number;
  createdAt: string;
  updatedAt: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const boundedString = (value: unknown, maximum: number) =>
  typeof value === "string" && value.length <= maximum ? value : null;

const nullableString = (value: unknown) =>
  value === null || typeof value === "string" ? value : undefined;

function parseEnvelope(value: unknown) {
  if (!isRecord(value)) throw new Error("Sync returned a malformed envelope");
  const id = boundedString(value.id, MAX_ID_LENGTH);
  const nonce = boundedString(value.nonce, 128);
  const payload = boundedString(value.payload, MAX_PAYLOAD_LENGTH);
  if (
    !id ||
    (value.kind !== KIND_MEMORY && value.kind !== KIND_PLAYBOOK) ||
    value.v !== ENVELOPE_VERSION ||
    value.suite !== SUITE_AES_256_GCM ||
    !Number.isSafeInteger(value.keyGen) ||
    Number(value.keyGen) < 1 ||
    !Number.isSafeInteger(value.version) ||
    Number(value.version) < 1 ||
    typeof value.tombstone !== "boolean" ||
    nonce === null ||
    payload === null
  ) {
    throw new Error("Sync returned an unsupported envelope");
  }
  if (!nonce || !payload) {
    throw new Error("Sync returned an empty encrypted envelope");
  }
  return {
    id,
    kind: value.kind,
    v: value.v,
    suite: value.suite,
    keyGen: Number(value.keyGen),
    version: Number(value.version),
    tombstone: value.tombstone,
    nonce,
    payload,
  } satisfies WireEnvelope;
}

export function parsePull(value: unknown, expectedOrgId: string) {
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

export function parseMemoryPayload(value: string) {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed)) throw new Error("Memory payload is malformed");
  const content = boundedString(parsed.content, MAX_PAYLOAD_LENGTH);
  const projectId = nullableString(parsed.project_id);
  const name = nullableString(parsed.name);
  const trigger = nullableString(parsed.trigger);
  if (
    content === null ||
    projectId === undefined ||
    typeof parsed.type !== "string" ||
    !MEMORY_TYPES.has(parsed.type) ||
    name === undefined ||
    trigger === undefined ||
    typeof parsed.confidence !== "number" ||
    !Number.isFinite(parsed.confidence) ||
    typeof parsed.created_at !== "string" ||
    typeof parsed.updated_at !== "string"
  ) {
    throw new Error("Memory payload is malformed");
  }
  return {
    content,
    projectId,
    type: parsed.type,
    name,
    trigger,
    confidence: parsed.confidence,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  };
}

export function payloadFor(memory: MemoryRecord) {
  return JSON.stringify({
    content: memory.content,
    project_id: memory.projectId,
    type: memory.type,
    name: memory.name,
    trigger: memory.trigger,
    confidence: memory.confidence,
    created_at: memory.createdAt,
    updated_at: memory.updatedAt,
  });
}

export function applyOpened(
  memories: Map<string, MemoryRecord>,
  envelope: WireEnvelope,
  payload: string | null,
) {
  const current = memories.get(envelope.id);
  if (current && current.version > envelope.version) return false;
  if (envelope.tombstone) {
    memories.delete(envelope.id);
    return true;
  }
  if (payload === null) throw new Error("Memory payload is missing");
  memories.set(envelope.id, {
    id: envelope.id,
    version: envelope.version,
    ...parseMemoryPayload(payload),
  });
  return true;
}

export function filterMemories(
  memories: Iterable<MemoryRecord>,
  filters: { query: string; project: string; type: string; page: number },
) {
  const query = filters.query.trim().toLocaleLowerCase();
  const found = Array.from(memories)
    .filter(
      (memory) =>
        (!query ||
          memory.content.toLocaleLowerCase().includes(query) ||
          memory.name?.toLocaleLowerCase().includes(query)) &&
        (!filters.project || memory.projectId === filters.project) &&
        (!filters.type || memory.type === filters.type),
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
