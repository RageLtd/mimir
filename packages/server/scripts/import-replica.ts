/**
 * One-shot Surreal → local-replica import (MIM-84 slice 3).
 *
 * Pulls the org memory brain out of the server's SurrealDB into the local
 * plaintext replica (~/.mimir/org-replica.db) that the client-side brain
 * reads. The alpha bridge until MIM-86 relocates extraction client-side:
 * re-run it by hand whenever the server store has grown — upserts by id,
 * so re-running only tops up.
 *
 * Deliberately NOT copied: embeddings. The server's vectors are Cohere-
 * space (or homelab qwen-space); the local brain embeds with its own model
 * (MIM-85) and cross-space similarity is noise — proven when the cloud
 * import mixed Cohere queries with qwen documents. Rows land with
 * embedding = NULL and MIM-85's backfill (listUnembedded/setEmbedding)
 * fills them in.
 *
 * Usage (from packages/server; source defaults to the normal server env):
 *   MIMIR_LOG_FILE=/tmp/mimir-import-replica.log bun scripts/import-replica.ts
 *
 * Overrides: SOURCE_SURREAL_URL/USER/PASS/NS/DB, REPLICA_DB_PATH.
 * MIMIR_LOG_FILE matters locally — the pino file stream defaults to
 * /data/mimir.log, unwritable outside the container.
 */

import { join } from "node:path";
import {
  createOrgReplica,
  type MemoryType,
  type UpsertMemory,
} from "@mimir/plugin-core/store/org-replica";
import { mimirHome } from "@mimir/plugin-core/util";
import { type RecordId, Surreal } from "surrealdb";
import { log } from "../src/util/logger";

// Env-only source (MIM-88: the runtime lost config.surreal — this script
// is the last Surreal speaker, kept as the MIM-92 migration bridge).
const SOURCE = {
  url: Bun.env.SOURCE_SURREAL_URL ?? Bun.env.SURREAL_URL ?? "",
  user: Bun.env.SOURCE_SURREAL_USER ?? Bun.env.SURREAL_USER ?? "root",
  pass: Bun.env.SOURCE_SURREAL_PASS ?? Bun.env.SURREAL_PASS ?? "root",
  namespace: Bun.env.SOURCE_SURREAL_NS ?? Bun.env.SURREAL_NS ?? "mimir",
  database: Bun.env.SOURCE_SURREAL_DB ?? Bun.env.SURREAL_DB ?? "mimir",
};

const REPLICA_DB_PATH =
  Bun.env.REPLICA_DB_PATH ?? join(mimirHome(), "org-replica.db");

const PAGE_SIZE = 100;
/** A read that outlives this is a silently-dead websocket — the SDK's
 *  promise never settles and the process would exit 0 looking like
 *  success. Fail loudly; re-running resumes (upserts are idempotent). */
const PAGE_TIMEOUT_MS = 60_000;

const MEMORY_TYPES: readonly MemoryType[] = [
  "fact",
  "summary",
  "playbook",
  "skill",
];

const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(`operation exceeded ${ms}ms — connection presumed dead`),
          ),
        ms,
      );
    }),
  ]);

const connect = async () => {
  const db = new Surreal();
  await db.connect(SOURCE.url);
  await db.signin({ username: SOURCE.user, password: SOURCE.pass });
  await db.use({ namespace: SOURCE.namespace, database: SOURCE.database });
  return db;
};

type Row = Record<string, unknown> & { id: RecordId | string };

const pageThrough = async function* (db: Surreal, table: string, omit = "") {
  let start = 0;
  for (;;) {
    const [rows] = await withTimeout(
      db.query<[Row[]]>(
        `SELECT * ${omit} FROM ${table} ORDER BY id LIMIT ${PAGE_SIZE} START ${start}`,
      ),
      PAGE_TIMEOUT_MS,
    );
    const page = rows ?? [];
    if (page.length === 0) return;
    yield page;
    if (page.length < PAGE_SIZE) return;
    start += PAGE_SIZE;
  }
};

/** Surreal datetimes arrive as Date objects; the replica stores SQLite's
 *  "YYYY-MM-DD HH:MM:SS" (UTC) so imported and locally-created rows sort
 *  consistently under ORDER BY created_at. */
const toSqliteUtc = (value: unknown) => {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 19).replace("T", " ");
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 19).replace("T", " ");
    }
  }
  return undefined;
};

const asOptionalString = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const asOptionalNumber = (value: unknown) =>
  typeof value === "number" ? value : undefined;

const toMemoryType = (value: unknown) => {
  const found = MEMORY_TYPES.find((t) => t === value);
  return found ?? "fact";
};

const toUpsert = (row: Row) => {
  const content = asOptionalString(row.content);
  if (!content) return null;
  const memory: UpsertMemory = {
    id: String(row.id),
    org_id: asOptionalString(row.org_id) ?? "",
    content,
    project_id: asOptionalString(row.project_id),
    type: toMemoryType(row.type),
    name: asOptionalString(row.name),
    trigger: asOptionalString(row.trigger),
    message_count: asOptionalNumber(row.message_count),
    last_message_id: asOptionalString(row.last_message_id),
    token_count: asOptionalNumber(row.token_count),
    confidence: asOptionalNumber(row.confidence) ?? 1.0,
    access_count: asOptionalNumber(row.access_count) ?? 0,
    created_at: toSqliteUtc(row.created_at),
    last_accessed: toSqliteUtc(row.last_accessed),
  };
  return memory;
};

const main = async () => {
  log.info(
    { source: SOURCE.url, replica: REPLICA_DB_PATH },
    "replica import starting",
  );

  const source = await connect();
  const replica = createOrgReplica(REPLICA_DB_PATH);

  let memories = 0;
  let skippedRows = 0;
  // OMIT embedding — vectors are model-space-bound and never imported.
  for await (const page of pageThrough(source, "memory", "OMIT embedding")) {
    for (const row of page) {
      const memory = toUpsert(row);
      if (!memory) {
        skippedRows++;
        log.warn({ id: String(row.id) }, "memory row without content skipped");
        continue;
      }
      replica.upsertMemory(memory);
      memories++;
    }
  }

  let relations = 0;
  for await (const page of pageThrough(source, "relates_to")) {
    for (const row of page) {
      const fromId = asOptionalString(String(row.in ?? ""));
      const toId = asOptionalString(String(row.out ?? ""));
      const weight = asOptionalNumber(row.weight);
      if (!fromId || !toId || weight === undefined) {
        skippedRows++;
        log.warn({ id: String(row.id) }, "malformed relates_to row skipped");
        continue;
      }
      replica.createRelation(
        fromId,
        toId,
        weight,
        asOptionalString(row.relation_type) ?? "relates_to",
      );
      relations++;
    }
  }

  const total = replica.countMemories();
  const unembedded = replica.listUnembedded(1).length > 0;
  replica.close();
  await source.close();

  log.info(
    {
      imported: memories,
      relations,
      skippedRows,
      replicaTotal: total,
      awaitingLocalEmbeddings: unembedded,
      replica: REPLICA_DB_PATH,
    },
    "replica import complete",
  );
};

main().catch((err) => {
  log.fatal(
    { err: err instanceof Error ? err.message : String(err) },
    "replica import failed",
  );
  process.exit(1);
});
