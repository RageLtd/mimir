import { describe, expect, test } from "bun:test";
import { ORG_SCOPED_TABLES } from "./migrate-org-scope";
import {
  buildDriftRemovalSql,
  buildOrphanValuePurgeSql,
  CART_DECLARED_FIELDS,
  parseIndexDimension,
} from "./schema-drift";

// Mirrors the cart_file DEFINE block in initSchema. content_hash is a LEGIT
// declared field (drifted once, now part of the source) and must survive.
const CART_FILE_DECLARED = [
  "project",
  "file_path",
  "language",
  "symbols",
  "searchable",
  "content_hash",
  "indexed_at",
] as const;

describe("buildDriftRemovalSql", () => {
  test("removes live fields the schema no longer declares", () => {
    const live = [...CART_FILE_DECLARED, "last_parsed_epoch", "symbol_names"];
    const sql = buildDriftRemovalSql("cart_file", live, CART_FILE_DECLARED);
    expect(sql).toEqual([
      "REMOVE FIELD IF EXISTS last_parsed_epoch ON TABLE cart_file;",
      "REMOVE FIELD IF EXISTS symbol_names ON TABLE cart_file;",
    ]);
  });

  test("preserves every declared field (content_hash is legit, not drift)", () => {
    const sql = buildDriftRemovalSql(
      "cart_file",
      [...CART_FILE_DECLARED],
      CART_FILE_DECLARED,
    );
    expect(sql).toEqual([]);
  });

  test("no-op on a clean schema", () => {
    const declared = ["project", "specifier"];
    const sql = buildDriftRemovalSql("cart_import", declared, declared);
    expect(sql).toEqual([]);
  });

  test("leaves nested field definitions alone", () => {
    const live = ["project", "symbols", "symbols[*]", "meta.kind", "stray"];
    const declared = ["project", "symbols"];
    const sql = buildDriftRemovalSql("cart_file", live, declared);
    expect(sql).toEqual(["REMOVE FIELD IF EXISTS stray ON TABLE cart_file;"]);
  });
});

describe("CART_DECLARED_FIELDS lockstep", () => {
  // Regression: slice 4c/5 added org_id to the cart DEFINE block but not to
  // this drift list, so removeDriftedCartFields stripped it back off before
  // migrateOrgScope's backfill, aborting boot with "no such field 'org_id'".
  // Every org-scoped cart table this module manages must declare org_id.
  test("declares org_id for every org-scoped cart table it manages", () => {
    for (const table of ORG_SCOPED_TABLES) {
      const declared = CART_DECLARED_FIELDS[table];
      if (!declared) continue; // schema-drift only manages cart_file/cart_import
      expect(declared).toContain("org_id");
    }
  });
});

describe("buildOrphanValuePurgeSql", () => {
  test("purges all orphans in ONE statement so the post-image validates", () => {
    // A row carrying several orphans must have them unset together —
    // unsetting one at a time leaves the others rejecting the UPDATE.
    const sql = buildOrphanValuePurgeSql("cart_file", [
      "last_parsed_epoch",
      "symbol_names",
    ]);
    expect(sql).toBe(
      "UPDATE cart_file UNSET last_parsed_epoch, symbol_names WHERE last_parsed_epoch != NONE OR symbol_names != NONE;",
    );
  });

  test("single orphan produces a single-field purge", () => {
    const sql = buildOrphanValuePurgeSql("cart_import", ["stray"]);
    expect(sql).toBe(
      "UPDATE cart_import UNSET stray WHERE stray != NONE;",
    );
  });

  test("no orphans → null (no statement issued)", () => {
    expect(buildOrphanValuePurgeSql("cart_file", [])).toBeNull();
  });
});

describe("parseIndexDimension", () => {
  test("extracts the DIMENSION from an HNSW definition", () => {
    expect(
      parseIndexDimension(
        "DEFINE INDEX memory_vec ON memory FIELDS embedding HNSW DIMENSION 1024 DIST COSINE EFC 150 M 12",
      ),
    ).toBe(1024);
  });

  test("non-vector definitions → null", () => {
    expect(
      parseIndexDimension("DEFINE INDEX memory_type ON memory FIELDS type"),
    ).toBeNull();
  });
});
