import { describe, expect, test } from "bun:test";
import { buildDriftRemovalSql } from "./surreal";

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
