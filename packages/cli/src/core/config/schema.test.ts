import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONFIG,
  parseConfig,
  setConfigPath,
  stringifyConfig,
} from "./schema.ts";

const data = (text: string) => parseConfig(text)[1];
const error = (text: string) => parseConfig(text)[0]?.message ?? "";

describe("parseConfig", () => {
  test("empty document yields defaults", () => {
    expect(data("")).toEqual(DEFAULT_CONFIG);
  });

  test("partial document fills gaps from defaults", () => {
    expect(data('[agent]\nmodel = "opus"\n')).toEqual({
      agent: { model: "opus", permissionMode: "default" },
      ui: DEFAULT_CONFIG.ui,
    });
  });

  test("unknown keys are ignored", () => {
    expect(data('[agent]\nfoo = 1\n[extra]\nbar = "x"\n')).toEqual(
      DEFAULT_CONFIG,
    );
  });

  test("malformed TOML is an error, not a throw", () => {
    expect(error("[agent\nmodel = ")).toStartWith("malformed TOML");
  });

  test("wrong types are reported by path", () => {
    expect(error("[agent]\nmodel = 3\n")).toBe(
      "agent.model: expected a string",
    );
    expect(error('[agent]\npermissionMode = "yolo"\n')).toContain(
      "agent.permissionMode",
    );
    expect(error("[ui]\naccent = true\n")).toBe("ui.accent: expected a string");
    expect(error('[ui]\nmuted = "purple"\n')).toStartWith("ui.muted: expected");
  });

  test("colour strings accept default, ansi:N and hex", () => {
    expect(data('[ui]\naccent = "ansi:12"\nmuted = "default"\n')?.ui).toEqual({
      accent: "ansi:12",
      muted: "default",
    });
    expect(
      setConfigPath(DEFAULT_CONFIG, "ui.accent", "#ff00ff")[1]?.ui.accent,
    ).toBe("#ff00ff");
    expect(
      setConfigPath(DEFAULT_CONFIG, "ui.accent", "red")[0]?.message ?? "",
    ).toStartWith("ui.accent: expected");
  });

  test("stringify → parse round-trips", () => {
    const config = {
      agent: { model: "sonnet", permissionMode: "acceptEdits" as const },
      ui: { accent: "#ff0000", muted: "#333333" },
    };
    expect(data(stringifyConfig(config))).toEqual(config);
  });
});

describe("setConfigPath", () => {
  test("sets a known key without mutating the original", () => {
    const [, next] = setConfigPath(DEFAULT_CONFIG, "agent.model", "opus");
    expect(next?.agent.model).toBe("opus");
    expect(DEFAULT_CONFIG.agent.model).toBeUndefined();
  });

  test("validates enum values", () => {
    expect(
      setConfigPath(DEFAULT_CONFIG, "agent.permissionMode", "nope")[0]?.message,
    ).toContain("agent.permissionMode");
    expect(
      setConfigPath(DEFAULT_CONFIG, "agent.permissionMode", "plan")[1]?.agent
        .permissionMode,
    ).toBe("plan");
  });

  test("rejects unknown keys", () => {
    expect(setConfigPath(DEFAULT_CONFIG, "nope.key", "x")[0]?.message).toBe(
      "unknown config key: nope.key",
    );
  });
});
