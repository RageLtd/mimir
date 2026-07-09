/**
 * One-shot Surreal → SQLite project export (MIM-88; Surreal exits).
 *
 * Copies every project row out of the old SurrealDB into the tenant
 * SQLite store, preserving ids (clients hold them in disk caches and
 * memory rows reference them). Run ONCE per deployment while the old
 * Surreal instance is still reachable, BEFORE deploying the
 * Surreal-less server build:
 *
 *   MIMIR_LOG_FILE=/tmp/mimir-export-projects.log \
 *   MIMIR_DB_PATH=/path/to/mimir.sqlite \
 *   bun scripts/export-projects.ts
 *
 * Overrides: SOURCE_SURREAL_URL/USER/PASS/NS/DB (defaults to the normal
 * server env, same convention as import-replica.ts). Idempotent —
 * re-running upserts by id.
 *
 * `surrealdb` is a devDependency: the runtime lost it in MIM-88; only
 * the export scripts still speak to the old store.
 */

import { type RecordId, Surreal } from "surrealdb";
import { config } from "../src/config";
import { createTenantDb } from "../src/db/tenant";
import { log } from "../src/util/logger";

const SOURCE = {
  url: Bun.env.SOURCE_SURREAL_URL ?? Bun.env.SURREAL_URL ?? "",
  user: Bun.env.SOURCE_SURREAL_USER ?? Bun.env.SURREAL_USER ?? "root",
  pass: Bun.env.SOURCE_SURREAL_PASS ?? Bun.env.SURREAL_PASS ?? "root",
  namespace: Bun.env.SOURCE_SURREAL_NS ?? Bun.env.SURREAL_NS ?? "mimir",
  database: Bun.env.SOURCE_SURREAL_DB ?? Bun.env.SURREAL_DB ?? "mimir",
};

type SurrealProject = {
  id: string | RecordId;
  org_id?: string;
  title?: string;
  description?: string;
  git_remote?: string;
  local_path?: string;
  technologies?: string[];
  purpose?: string;
  created_at?: string | Date;
  updated_at?: string | Date;
};

const idString = (id: string | RecordId) => {
  const raw = typeof id === "string" ? id : String(id.id);
  const colon = raw.indexOf(":");
  return colon >= 0 ? raw.slice(colon + 1) : raw;
};

const toSqliteDate = (value: string | Date | undefined) => {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  return date.toISOString().slice(0, 19).replace("T", " ");
};

async function main() {
  if (!SOURCE.url) {
    throw new Error("SOURCE_SURREAL_URL (or SURREAL_URL) is required");
  }
  const surreal = new Surreal();
  await surreal.connect(SOURCE.url);
  await surreal.signin({ username: SOURCE.user, password: SOURCE.pass });
  await surreal.use({
    namespace: SOURCE.namespace,
    database: SOURCE.database,
  });
  const [rows] = await surreal.query<[SurrealProject[]]>(
    "SELECT * FROM project",
  );
  await surreal.close();

  const db = createTenantDb(config.tenantDbPath);
  let exported = 0;
  for (const row of rows ?? []) {
    db.query(
      `INSERT INTO project (
        id, org_id, git_remote, local_path, title, description,
        technologies, purpose, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,
        COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))
      ON CONFLICT(id) DO UPDATE SET
        org_id = excluded.org_id,
        git_remote = excluded.git_remote,
        local_path = excluded.local_path,
        title = excluded.title,
        description = excluded.description,
        technologies = excluded.technologies,
        purpose = excluded.purpose,
        updated_at = excluded.updated_at`,
    ).run(
      idString(row.id),
      row.org_id ?? "owner",
      row.git_remote ?? null,
      row.local_path ?? null,
      row.title ?? null,
      row.description ?? null,
      JSON.stringify(row.technologies ?? []),
      row.purpose ?? null,
      toSqliteDate(row.created_at),
      toSqliteDate(row.updated_at),
    );
    exported += 1;
  }
  log.info(
    { exported, target: config.tenantDbPath },
    "project export complete",
  );
  console.log(`exported ${exported} project(s) → ${config.tenantDbPath}`);
}

await main();
