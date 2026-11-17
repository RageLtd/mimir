import { describe, expect, test } from "bun:test";
import {
  MOD_TYPES_TSCONFIG,
  modLeg,
  PACKAGES,
  packagesToRun,
  parseArgs,
  REQUIRE_MOD_TYPES_FLAG,
} from "./typecheck-plan";

const FLAG = "--require-mod-types";
const CC_PLUGIN = "cc-plugin";
const OTHER_PACKAGE = "plugin-core";
const ROOT_NAME = "mimir";

describe("parseArgs", () => {
  test("the flag is spelled --require-mod-types", () => {
    expect(REQUIRE_MOD_TYPES_FLAG).toBe(FLAG);
  });

  test("no arguments: no filter, flag off", () => {
    expect(parseArgs([])).toEqual({
      filter: undefined,
      requireModTypes: false,
    });
  });

  test("a package name alone is the filter, flag off", () => {
    expect(parseArgs([OTHER_PACKAGE])).toEqual({
      filter: OTHER_PACKAGE,
      requireModTypes: false,
    });
  });

  test("the flag alone sets the flag and is not taken as the filter", () => {
    expect(parseArgs([FLAG])).toEqual({
      filter: undefined,
      requireModTypes: true,
    });
  });

  test("filter then flag", () => {
    expect(parseArgs([CC_PLUGIN, FLAG])).toEqual({
      filter: CC_PLUGIN,
      requireModTypes: true,
    });
  });

  test("flag then filter", () => {
    expect(parseArgs([FLAG, CC_PLUGIN])).toEqual({
      filter: CC_PLUGIN,
      requireModTypes: true,
    });
  });

  test("the gate's root case: a non-package name with the flag", () => {
    expect(parseArgs([ROOT_NAME, FLAG])).toEqual({
      filter: ROOT_NAME,
      requireModTypes: true,
    });
  });
});

describe("packagesToRun", () => {
  test("no filter means every package", () => {
    expect(packagesToRun(undefined)).toEqual(PACKAGES);
  });

  test("a package filter narrows to that package", () => {
    expect(packagesToRun(OTHER_PACKAGE)).toEqual([OTHER_PACKAGE]);
    expect(packagesToRun(CC_PLUGIN)).toEqual([CC_PLUGIN]);
  });

  test("a non-package name means every package", () => {
    expect(packagesToRun(ROOT_NAME)).toEqual(PACKAGES);
  });

  test("the flag does not change which packages run", () => {
    for (const argv of [
      [FLAG],
      [ROOT_NAME, FLAG],
      [FLAG, OTHER_PACKAGE],
      [CC_PLUGIN, FLAG],
    ]) {
      const withFlag = parseArgs(argv);
      const withoutFlag = parseArgs(argv.filter((a) => a !== FLAG));
      expect(packagesToRun(withFlag.filter)).toEqual(
        packagesToRun(withoutFlag.filter),
      );
    }
  });
});

describe("modLeg", () => {
  // Every filter under which the hooks-module leg is considered.
  const CONSIDERED = [undefined, CC_PLUGIN, ROOT_NAME];

  test("declarations present: run, with or without the flag", () => {
    for (const filter of CONSIDERED) {
      for (const requireModTypes of [false, true]) {
        expect(
          modLeg({ filter, typesPresent: true, requireModTypes }).kind,
        ).toBe("run");
      }
    }
  });

  test("declarations absent, no flag: skip as today", () => {
    for (const filter of CONSIDERED) {
      const leg = modLeg({
        filter,
        typesPresent: false,
        requireModTypes: false,
      });
      expect(leg.kind).toBe("skip");
    }
  });

  test("declarations absent, flag: fail", () => {
    for (const filter of CONSIDERED) {
      const leg = modLeg({
        filter,
        typesPresent: false,
        requireModTypes: true,
      });
      expect(leg.kind).toBe("fail");
    }
  });

  test("another package's filter: leg not considered, whatever else holds", () => {
    for (const typesPresent of [false, true]) {
      for (const requireModTypes of [false, true]) {
        expect(
          modLeg({ filter: OTHER_PACKAGE, typesPresent, requireModTypes }).kind,
        ).toBe("not-considered");
      }
    }
  });

  test("the failure message names the path and how to lay it", () => {
    const leg = modLeg({
      filter: undefined,
      typesPresent: false,
      requireModTypes: true,
    });
    if (leg.kind !== "fail") {
      throw new Error(`expected a fail decision, got ${leg.kind}`);
    }
    expect(leg.message).toContain(MOD_TYPES_TSCONFIG);
    expect(leg.message).toContain("--plugin-dir");
    expect(leg.message).toMatch(/interactive(ly)?/i);
    expect(leg.message).toMatch(/worktree/i);
    expect(leg.message).toMatch(/bootstrap/i);
  });

  test("the declarations path is the cc-plugin engine types tsconfig", () => {
    expect(MOD_TYPES_TSCONFIG).toBe(
      "packages/cc-plugin/.claude-plugin/types/tsconfig.json",
    );
  });
});
