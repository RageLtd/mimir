import { describe, expect, test } from "bun:test";
import { parseStatus } from "./status";

describe("parseStatus", () => {
  test("reads the STATUS line, case-insensitively, last one wins", () => {
    expect(parseStatus("All good.\nSTATUS: done")).toBe("done");
    expect(parseStatus("status: Question\nwhich API?")).toBe("question");
    expect(parseStatus("STATUS: done\n…\nSTATUS: blocked")).toBe("blocked");
    expect(parseStatus("  STATUS: failed  ")).toBe("failed");
  });

  test("no line or unknown value → null", () => {
    expect(parseStatus("I finished everything")).toBeNull();
    expect(parseStatus("STATUS: complete")).toBeNull();
    expect(parseStatus("the STATUS: done of it")).toBeNull();
  });
});
