import { describe, expect, test } from "bun:test";
import {
  buildCodexPermissionHookConfig,
  type CodexPermissionBridge,
} from "./permission-bridge";

describe("Codex permission bridge", () => {
  test("omits hook config when no bridge is available", () => {
    expect(buildCodexPermissionHookConfig(null)).toEqual({});
  });

  test("builds a PermissionRequest hook command for Codex", () => {
    const bridge: CodexPermissionBridge = {
      socketPath: "/tmp/mimir-codex-permissions/session.sock",
      command: "'/usr/local/bin/bun' '/tmp/mimir-codex-permissions/permission-hook.js' '/tmp/mimir-codex-permissions/session.sock'",
      close: async () => undefined,
    };

    const config = buildCodexPermissionHookConfig(bridge);

    expect(config.features).toEqual({ hooks: true });
    expect(config.hooks).toEqual({
      PermissionRequest: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: bridge.command,
              timeout: 300,
              statusMessage: "Waiting for editor approval",
            },
          ],
        },
      ],
    });
  });
});
