/**
 * Re-embedding brain import: homelab SurrealDB → cloud SurrealDB.
 *
 * The cloud deployment embeds with a different model than the homelab
 * (Cohere embed-v4.0 vs local qwen3-embedding:0.6b), and vectors only
 * match the space they were embedded in — so memory rows cannot import
 * verbatim. This script:
 *
 *   1. Copies project, message_log, cart_file, cart_import, cart_git_state
 *      rows verbatim (no embeddings there), preserving record ids.
 *   2. RE-EMBEDS every memory row through the DESTINATION-configured
 *      embedder (EMBED_TYPE/EMBED_MODEL/EMBED_API_KEY env): facts and
 *      summaries embed their content; playbooks embed name+trigger —
 *      mirroring storeTypedMemory / updatePlaybook.
 *   3. Recreates relates_to edges between the preserved memory ids.
 *
 * Skipped deliberately: compaction_state / hygiene_state (fresh state).
 *
 * Usage (from packages/server):
 *   SOURCE_SURREAL_URL=... SOURCE_SURREAL_USER=... SOURCE_SURREAL_PASS=... \
 *   EMBED_TYPE=cohere EMBED_MODEL=embed-v4.0 EMBED_API_KEY=... \
 *   MIMIR_LOG_FILE=/tmp/mimir-import.log bun scripts/reembed-import.ts
 *
 * MIMIR_LOG_FILE matters when running locally: the pino file stream
 * defaults to /data/mimir.log, which is not writable outside the container.
 *
 * Destination defaults to the normal server env (SURREAL_URL etc.) and can
 * be overridden with DEST_SURREAL_URL / DEST_SURREAL_USER / DEST_SURREAL_PASS
 * — useful when .env points at the local instance but the import targets
 * the cloud. Idempotent-ish: rows are inserted with original ids;
 * re-running skips rows that already exist.
 */

import { RecordId, Surreal } from "surrealdb";
import { config } from "../src/config";
import { embed } from "../src/goldfish/clients";
import { log } from "../src/util/logger";

const SOURCE = {
  url: Bun.env.SOURCE_SURREAL_URL ?? "",
  user: Bun.env.SOURCE_SURREAL_USER ?? "",
  pass: Bun.env.SOURCE_SURREAL_PASS ?? "",
  namespace: Bun.env.SOURCE_SURREAL_NS ?? "mimir",
  database: Bun.env.SOURCE_SURREAL_DB ?? "mimir",
};

const DEST = {
  url: Bun.env.DEST_SURREAL_URL ?? config.surreal.url,
  user: Bun.env.DEST_SURREAL_USER ?? config.surreal.user,
  pass: Bun.env.DEST_SURREAL_PASS ?? config.surreal.pass,
  namespace: Bun.env.DEST_SURREAL_NS ?? config.surreal.namespace,
  database: Bun.env.DEST_SURREAL_DB ?? config.surreal.database,
};

const VERBATIM_TABLES = [
  "project",
  "message_log",
  "cart_file",
  "cart_import",
  "cart_git_state",
] as const;

const PAGE_SIZE = 100;
/** Pause between destination writes. The Surreal Cloud free tier
 *  (quarter-vCPU) falls over under a sustained write burst — pacing the
 *  pages keeps the instance alive for the whole crossing. */
const PAGE_DELAY_MS = 300;
const EMBED_BATCH = 64;
/** A bulk insert that outlives this is a silently-dead websocket — the
 *  SDK's promise never settles, Bun's loop drains, and the process would
 *  exit 0 looking like success. Fail LOUDLY instead; re-running resumes
 *  (INSERT IGNORE skips everything already present). */
const PAGE_TIMEOUT_MS = 60_000;

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

const connect = async (opts: {
  url: string;
  user: string;
  pass: string;
  namespace: string;
  database: string;
}) => {
  const db = new Surreal();
  await db.connect(opts.url);
  await db.signin({ username: opts.user, password: opts.pass });
  await db.use({ namespace: opts.namespace, database: opts.database });
  return db;
};

type Row = Record<string, unknown> & { id: RecordId | string };

const pageThrough = async function* (db: Surreal, table: string) {
  let start = 0;
  for (;;) {
    const [rows] = await db.query<[Row[]]>(
      `SELECT * FROM ${table} ORDER BY id LIMIT ${PAGE_SIZE} START ${start}`,
    );
    const page = rows ?? [];
    if (page.length === 0) return;
    yield page;
    if (page.length < PAGE_SIZE) return;
    start += PAGE_SIZE;
  }
};

/**
 * Bulk-insert rows preserving original ids. INSERT IGNORE skips rows whose
 * id already exists (the idempotency primitive) and returns only the rows
 * it actually created — one round-trip per page instead of two per row,
 * which is the difference between minutes and hours against a cloud
 * instance at WAN latency.
 */
const bulkInsert = async (db: Surreal, table: string, rows: Row[]) => {
  const payload = rows.map((row) => ({
    ...row,
    id:
      row.id instanceof RecordId
        ? row.id
        : new RecordId(table, String(row.id).replace(`${table}:`, "")),
  }));

  const [created] = await withTimeout(
    db.query<[Row[]]>(`INSERT IGNORE INTO ${table} $rows`, { rows: payload }),
    PAGE_TIMEOUT_MS,
  );
  if (PAGE_DELAY_MS > 0) await Bun.sleep(PAGE_DELAY_MS);
  const copied = (created ?? []).length;
  return { copied, skipped: rows.length - copied };
};

/** What a memory row embeds — mirrors storeTypedMemory / updatePlaybook. */
const embedSource = (m: Row) =>
  m.type === "playbook" && m.trigger
    ? `${m.name ?? ""}\n${m.trigger}`.trim()
    : String(m.content ?? "");

const importVerbatim = async (source: Surreal, dest: Surreal) => {
  for (const table of VERBATIM_TABLES) {
    let copied = 0;
    let skipped = 0;
    let pages = 0;
    for await (const page of pageThrough(source, table)) {
      const result = await bulkInsert(dest, table, page);
      copied += result.copied;
      skipped += result.skipped;
      pages++;
      if (pages % 10 === 0) {
        log.info({ table, copied, skipped }, "import progress");
      }
    }
    log.info({ table, copied, skipped }, "table imported verbatim");
  }
};

const importMemories = async (source: Surreal, dest: Surreal) => {
  let copied = 0;
  let skipped = 0;
  let failed = 0;

  for await (const page of pageThrough(source, "memory")) {
    for (let i = 0; i < page.length; i += EMBED_BATCH) {
      const batch = page.slice(i, i + EMBED_BATCH);
      const embeddings = await embed(batch.map(embedSource), "document");
      if (!embeddings) {
        log.error(
          { batchSize: batch.length },
          "embedding batch failed — aborting; re-run to resume",
        );
        process.exit(1);
      }
      const rows = batch.map(
        (m, j) => ({ ...m, embedding: embeddings[j] }) as Row,
      );
      const result = await bulkInsert(dest, "memory", rows).catch((e) => {
        log.error(
          { err: e instanceof Error ? e.message : String(e) },
          "memory batch insert failed",
        );
        failed += rows.length;
        return null;
      });
      if (result) {
        copied += result.copied;
        skipped += result.skipped;
      }
    }
  }
  log.info({ copied, skipped, failed }, "memories re-embedded and imported");
};

const importRelations = async (source: Surreal, dest: Surreal) => {
  let created = 0;
  const [edges] = await source.query<
    [
      Array<{
        in: RecordId;
        out: RecordId;
        weight: number;
        relation_type: string;
      }>,
    ]
  >(`SELECT in, out, weight, relation_type FROM relates_to`);

  let skipped = 0;
  for (const edge of edges ?? []) {
    // Idempotency: RELATE happily duplicates edges on re-run.
    const [existing] = await dest.query<[Row[]]>(
      `SELECT id FROM relates_to WHERE in = $from AND out = $to LIMIT 1`,
      { from: edge.in, to: edge.out },
    );
    if ((existing ?? []).length > 0) {
      skipped++;
      continue;
    }
    await dest.query(
      `RELATE $from -> relates_to -> $to SET weight = $weight, relation_type = $type`,
      {
        from: edge.in,
        to: edge.out,
        weight: edge.weight,
        type: edge.relation_type,
      },
    );
    created++;
  }
  log.info({ created, skipped }, "relates_to edges recreated");
};

const main = async () => {
  if (!SOURCE.url || !SOURCE.user || !SOURCE.pass) {
    log.error(
      "Set SOURCE_SURREAL_URL / SOURCE_SURREAL_USER / SOURCE_SURREAL_PASS (the homelab instance)",
    );
    process.exit(1);
  }

  if (SOURCE.url === DEST.url) {
    log.error(
      { url: SOURCE.url },
      "source and destination are the same instance — refusing to import onto itself",
    );
    process.exit(1);
  }

  log.info(
    {
      source: SOURCE.url,
      destination: DEST.url,
      embedder: config.embedding.type,
      model: config.embedding.model,
      dims: config.embedding.dimensions,
    },
    "re-embed import starting",
  );

  const source = await connect(SOURCE);
  const dest = await connect(DEST);

  await importVerbatim(source, dest);
  await importMemories(source, dest);
  await importRelations(source, dest);

  await source.close();
  await dest.close();
  log.info("import complete");
};

main().catch((err) => {
  log.error({ err }, "import failed");
  process.exit(1);
});
