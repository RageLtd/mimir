import { describe, expect, test } from "bun:test";
import { parseIndexDimension } from "./schema-drift";

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
