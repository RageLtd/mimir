/**
 * Replica sync API (MIM-88) — the store-side half of the sync engine.
 * Operates on the same bun:sqlite handle as the replica factory (which
 * spreads this into its return); knows nothing about envelopes or
 * ciphers — that is the sync seam's business (sync/envelope.ts).
 *
 * Lifecycle contract:
 *  - local writes mark rows dirty (org-replica.ts write paths);
 *  - `listDirty` feeds the push leg;
 *  - `markPushed` clears dirty and purges pushed tombstones;
 *  - `applyRemote` lands pulled records under LWW without dirtying them
 *    (embedding always NULL — vectors are model-space-bound and never
 *    sync; the local backfill re-embeds).
 */

import type { Database } from "bun:sqlite";

/** The plaintext payload a memory envelope carries (kind 0x01/0x02) —
 *  the row minus embedding and local usage noise (access counts and
 *  last_accessed are per-client signals, never org-shared). */
export type RemoteMemory = {
  readonly id: string;
  readonly version: number;
  readonly tombstone: boolean;
  readonly content: string;
  readonly project_id: string | null;
  readonly type: string;
  readonly name: string | null;
  readonly trigger: string | null;
  readonly confidence: number;
  readonly created_at: string;
  readonly updated_at: string;
};

export type DirtyRow = {
  readonly id: string;
  readonly version: number;
  readonly tombstone: number;
  readonly content: string;
  readonly project_id: string | null;
  readonly type: string;
  readonly name: string | null;
  readonly trigger: string | null;
  readonly confidence: number;
  readonly created_at: string;
  readonly updated_at: string;
};

export const createSyncApi = (db: Database) => {
  /** Every row awaiting a push — includes tombstones (they push as
   *  empty-payload envelopes and purge in markPushed). */
  const listDirty = () =>
    db
      .query<DirtyRow, []>(
        `SELECT id, version, tombstone, content, project_id, type, name,
                trigger, confidence, created_at, updated_at
         FROM memory WHERE dirty = 1`,
      )
      .all();

  /**
   * Land a pulled record under LWW. Local version higher → local wins
   * (skipped; a later push propagates it). Equal version with a DIRTY
   * local row → local wins the tie: the engine pulls before pushing, so
   * applying here would silently destroy unpushed work — instead the
   * local edit pushes and becomes the server's tie winner (last push
   * wins), and every other client converges on it. Equal-and-clean →
   * remote wins (own push echo replay, or a tie another client already
   * won server-side). Lower → remote wins outright.
   */
  const applyRemote = (record: RemoteMemory) => {
    const local = db
      .query<{ version: number; dirty: number }, [string]>(
        "SELECT version, dirty FROM memory WHERE id = ?",
      )
      .get(record.id);
    if (local && local.version > record.version) {
      return { applied: false, reason: "local-newer" } as const;
    }
    if (local && local.version === record.version && local.dirty === 1) {
      return { applied: false, reason: "local-dirty-tie" } as const;
    }
    if (record.tombstone) {
      db.query("DELETE FROM relates_to WHERE from_id = ? OR to_id = ?").run(
        record.id,
        record.id,
      );
      db.query("DELETE FROM memory WHERE id = ?").run(record.id);
      return { applied: true, reason: "tombstone" } as const;
    }
    db.query(
      `INSERT INTO memory (
        id, content, project_id, type, name, trigger, confidence,
        created_at, updated_at, version, dirty, tombstone, embedding
      ) VALUES ($id, $content, $project_id, $type, $name, $trigger,
        $confidence, $created_at, $updated_at, $version, 0, 0, NULL)
      ON CONFLICT(id) DO UPDATE SET
        content = excluded.content,
        project_id = excluded.project_id,
        type = excluded.type,
        name = excluded.name,
        trigger = excluded.trigger,
        confidence = excluded.confidence,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        version = excluded.version,
        dirty = 0,
        tombstone = 0,
        embedding = NULL`,
    ).run({
      $id: record.id,
      $content: record.content,
      $project_id: record.project_id,
      $type: record.type,
      $name: record.name,
      $trigger: record.trigger,
      $confidence: record.confidence,
      $created_at: record.created_at,
      $updated_at: record.updated_at,
      $version: record.version,
    });
    return { applied: true, reason: "upsert" } as const;
  };

  /** Clear dirty on pushed rows; physically purge pushed tombstones —
   *  the server's envelope now carries the deletion for everyone else. */
  const markPushed = (ids: string[]) => {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    db.query(`UPDATE memory SET dirty = 0 WHERE id IN (${placeholders})`).run(
      ...ids,
    );
    db.query(
      `DELETE FROM memory WHERE tombstone = 1 AND dirty = 0 AND id IN (${placeholders})`,
    ).run(...ids);
  };

  /** Raw vector for one row — the sync engine derives relates_to edges
   *  for pulled rows after the backfill embeds them (the storeTyped
   *  pattern needs the embedding in hand). */
  const getEmbedding = (id: string) => {
    const row = db
      .query<{ embedding: Uint8Array | null }, [string]>(
        "SELECT embedding FROM memory WHERE id = ?",
      )
      .get(id);
    if (!row?.embedding) return null;
    return Array.from(
      new Float32Array(
        row.embedding.buffer,
        row.embedding.byteOffset,
        row.embedding.byteLength / 4,
      ),
    );
  };

  const getSyncCursor = (orgId: string) =>
    db
      .query<{ cursor: number }, [string]>(
        "SELECT cursor FROM sync_state WHERE org_id = ?",
      )
      .get(orgId)?.cursor ?? 0;

  const setSyncCursor = (orgId: string, cursor: number) => {
    db.query(
      `INSERT INTO sync_state (org_id, cursor, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(org_id) DO UPDATE SET
         cursor = excluded.cursor, updated_at = excluded.updated_at`,
    ).run(orgId, cursor);
  };

  return {
    listDirty,
    applyRemote,
    markPushed,
    getEmbedding,
    getSyncCursor,
    setSyncCursor,
  };
};
