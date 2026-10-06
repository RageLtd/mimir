import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toAnthropicXml } from "@mimir/plugin-core/anthropic-xml";
import { renderOutputStyle } from "./install";

const serverSeed = await Bun.file(
  join(import.meta.dir, "..", "..", "server", "system-prompt.md"),
).text();

test.each([
  [
    "whitespace fixture",
    "# Mimir\n\n## Identity and Voice\n\nCanonical persona.\n\n",
  ],
  ["canonical server seed", serverSeed],
])("install preserves %s exactly and isolates CC enrichment", async (_, persona) => {
  const home = await mkdtemp(join(tmpdir(), "mimir-cc-install-"));
  const mimirDir = join(home, ".mimir");
  const claudeDir = join(home, ".claude");
  const stopMessage = "fixture stops before binary installation";
  try {
    // Module mocks stay in a subprocess: the suite runs files in parallel.
    const proc = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          import { mock, spyOn } from "bun:test";
          mock.module("@mimir/plugin-core/cartographer/resolve", () => ({
            resolveCartographerBinary: async () => ({ ok: true, binary: "fixture-cartographer" }),
          }));
          mock.module("@mimir/plugin-core/brain/embedder-install", () => ({
            installEmbedderArtifacts: async () => new Error(${JSON.stringify(stopMessage)}),
          }));
          spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
            content: ${JSON.stringify(persona)}, version: "fixture-version",
          }));
          const { runInstall } = await import(${JSON.stringify(join(import.meta.dir, "install.ts"))});
          console.log(JSON.stringify(await runInstall({ serverUrl: "https://mimir.example.com" })));
        `,
      ],
      {
        env: {
          ...process.env,
          HOME: home,
          MIMIR_HOME: mimirDir,
          CLAUDE_CONFIG_DIR: claudeDir,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      ok: false,
      error: `Embedder install failed: ${stopMessage}`,
    });

    expect(await Bun.file(join(mimirDir, "system-prompt.md")).text()).toBe(
      persona,
    );
    const xml = await Bun.file(
      join(mimirDir, "cc", "system-prompt.xml"),
    ).text();
    expect(xml).toBe(toAnthropicXml(persona));
    expect(xml).toContain("<environment>");
    expect(xml).toContain("<model_override>");
    expect(xml).toContain("mcp__plugin_mimir-cc_mimir-local__");
    expect(
      await Bun.file(join(claudeDir, "output-styles", "mimir.md")).text(),
    ).toBe(renderOutputStyle(xml));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
