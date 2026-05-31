#!/usr/bin/env bun
/**
 * One-shot migration: re-key cart_file / cart_import rows from filesystem
 * path keys to the canonical project UUID.
 *
 * During the Slice 1→2 transition window, new syncs write UUID-keyed rows
 * while orphaned path-keyed rows from earlier sessions remain. This script
 * reconciles them:
 *
 *   - For each project record with a local_path, find cart_file rows keyed
 *     by that path.
 *   - If a UUID-keyed row already exists for the same file_path, keep
 *     whichever has the newer indexed_at. Delete the loser.
 *   - If no UUID-keyed row exists, re-key the path row to the UUID.
 *   - Same logic for cart_import.
 *
 * Usage: bun packages/server/scripts/migrate-path-keys-to-uuid.ts
 *
 * Safe to run multiple times — idempotent. Logs what it does.
 */

import { RecordId } from "surrealdb";
import { initSchema } from "../src/db/surreal";
import { getDb, queryOne } from "../src/db/surreal";

type ProjectRow = {
  id: string | RecordId;
  local_path: string | null;
};

type CartFileRow = {
  id: string | RecordId;
  file_path: string;
  indexed_at: string;
};

type CartImportRow = {
  id: string | RecordId;
  source_path: string;
  target_path: string;
  specifier: string;
  indexed_at: string;
};

const idString = (id: string | RecordId) => {
  if (id instanceof RecordId) return String(id.id);
  const colon = id.indexOf(":");
  return colon >= 0 ? id.slice(colon + 1) : id;
};

const recordRef = (table: string, id: string | RecordId) =>
  id instanceof RecordId ? id : `${table}:⟨${id}⟩`;

async function main() {
  await initSchema();
  const db = await getDb();

  const projects = await queryOne<ProjectRow>(
    `SELECT id, local_path FROM project WHERE local_path IS NOT NONE`,
  );

  console.log(`Found ${projects.length} project(s) with local_path`);

  let totalReKeyed = 0;
  let totalDeleted = 0;
  let totalSkipped = 0;

  for (const proj of projects) {
    const projectId = idString(proj.id);
    const localPath = proj.local_path;
    if (!localPath) continue;

    console.log(`\nProject ${projectId} (path: ${localPath})`);

    // ── cart_file ──
    const pathFiles = await queryOne<CartFileRow>(
      `SELECT id, file_path, indexed_at FROM cart_file WHERE project = $path`,
      { path: localPath },
    );

    if (pathFiles.length === 0) {
      console.log("  cart_file: no path-keyed rows, skipping");
    } else {
      console.log(`  cart_file: ${pathFiles.length} path-keyed row(s)`);
    }

    for (const pathRow of pathFiles) {
      const uuidRow = await queryOne<CartFileRow>(
        `SELECT id, file_path, indexed_at FROM cart_file
         WHERE project = $uuid AND file_path = $fp LIMIT 1`,
        { uuid: projectId, fp: pathRow.file_path },
      );

      const existing = uuidRow[0];
      if (existing) {
        const pathTime = new Date(pathRow.indexed_at).getTime();
        const uuidTime = new Date(existing.indexed_at).getTime();

        if (pathTime > uuidTime) {
          // Path row is newer — delete UUID row, re-key path row
          await db.query(`DELETE $id`, {
            id: recordRef("cart_file", existing.id),
          });
          await db.query(
            `UPDATE $id SET project = $uuid`,
            { id: recordRef("cart_file", pathRow.id), uuid: projectId },
          );
          totalReKeyed++;
        } else {
          // UUID row is newer or same — just delete the path row
          await db.query(`DELETE $id`, {
            id: recordRef("cart_file", pathRow.id),
          });
          totalDeleted++;
        }
      } else {
        // No UUID-keyed row — re-key
        await db.query(
          `UPDATE $id SET project = $uuid`,
          { id: recordRef("cart_file", pathRow.id), uuid: projectId },
        );
        totalReKeyed++;
      }
    }

    // ── cart_import ──
    const pathImports = await queryOne<CartImportRow>(
      `SELECT id, source_path, target_path, specifier, indexed_at
       FROM cart_import WHERE project = $path`,
      { path: localPath },
    );

    if (pathImports.length === 0) {
      console.log("  cart_import: no path-keyed rows, skipping");
    } else {
      console.log(`  cart_import: ${pathImports.length} path-keyed row(s)`);
    }

    for (const pathRow of pathImports) {
      const uuidRow = await queryOne<CartImportRow>(
        `SELECT id, source_path, target_path, specifier, indexed_at
         FROM cart_import
         WHERE project = $uuid
           AND source_path = $src
           AND target_path = $tgt
           AND specifier = $spec
         LIMIT 1`,
        {
          uuid: projectId,
          src: pathRow.source_path,
          tgt: pathRow.target_path,
          spec: pathRow.specifier,
        },
      );

      const existing = uuidRow[0];
      if (existing) {
        const pathTime = new Date(pathRow.indexed_at).getTime();
        const uuidTime = new Date(existing.indexed_at).getTime();

        if (pathTime > uuidTime) {
          await db.query(`DELETE $id`, {
            id: recordRef("cart_import", existing.id),
          });
          await db.query(
            `UPDATE $id SET project = $uuid`,
            { id: recordRef("cart_import", pathRow.id), uuid: projectId },
          );
          totalReKeyed++;
        } else {
          await db.query(`DELETE $id`, {
            id: recordRef("cart_import", pathRow.id),
          });
          totalDeleted++;
        }
      } else {
        await db.query(
          `UPDATE $id SET project = $uuid`,
          { id: recordRef("cart_import", pathRow.id), uuid: projectId },
        );
        totalReKeyed++;
      }
    }
  }

  console.log(`\nDone. Re-keyed: ${totalReKeyed}, deleted (stale): ${totalDeleted}, skipped: ${totalSkipped}`);
  process.exit(0);
}

main();
