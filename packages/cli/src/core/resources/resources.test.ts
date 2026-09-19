import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadResource } from "./loader.ts";
import { mcpServersSpec } from "./mcp.ts";
import { discoverLocalPlugins } from "./plugins.ts";
import { findProjectRoot } from "./project-root.ts";

let root = "";
let home = "";
let project = "";
const previousHome = process.env.MIMIR_HOME;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mimir-cli-resources-"));
  home = join(root, "home");
  project = join(root, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(project, "pkg", "deep"), { recursive: true });
  await mkdir(home, { recursive: true });
  process.env.MIMIR_HOME = home;
});

afterAll(async () => {
  if (previousHome === undefined) {
    delete process.env.MIMIR_HOME;
  } else {
    process.env.MIMIR_HOME = previousHome;
  }
  await rm(root, { recursive: true, force: true });
});

describe("loadResource", () => {
  test("merges layers shallow→deep and reports each file", async () => {
    const dir = join(root, "layers");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.txt"), "a=1\nb=1");
    await writeFile(join(dir, "b.txt"), "b=2\nc=oops");
    const parse = (text: string) => {
      const value: Record<string, number> = {};
      const errors: string[] = [];
      for (const line of text.split("\n")) {
        const [key = "", raw = ""] = line.split("=");
        const n = Number(raw);
        if (Number.isNaN(n)) errors.push(`${key}: not a number`);
        else value[key] = n;
      }
      return { value, errors };
    };
    const { value, reports } = await loadResource({
      name: "test",
      layers: ["a.txt", "b.txt", "missing.txt"].map((name) => ({
        path: join(dir, name),
        parse,
      })),
      empty: {},
      merge: (base, over) => ({ ...base, ...over }),
    });
    expect(value).toEqual({ a: 1, b: 2 });
    expect(reports.map((r) => r.status)).toEqual([
      "loaded",
      "loaded",
      "missing",
    ]);
    expect(reports[1]?.errors).toEqual(["c: not a number"]);
  });
});

describe("mcpServersSpec", () => {
  test("layers global json, config.json, every mimir.toml, then project .mcp.json", async () => {
    await writeFile(
      join(home, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          global: { command: "g" },
          shadowed: { command: "old" },
          removed: { command: "r" },
        },
      }),
    );
    await writeFile(
      join(home, "config.json"),
      JSON.stringify({
        serverUrl: "x",
        mcpServers: { machine: { command: "m" } },
      }),
    );
    await writeFile(
      join(project, "mimir.toml"),
      '[mcp.servers.shadowed]\ncommand = "new"\n[mcp.servers.removed]\nenabled = false\n',
    );
    await writeFile(
      join(project, "pkg", "mimir.toml"),
      '[mcp.servers.pkg]\ntype = "http"\nurl = "https://p"\n',
    );
    await writeFile(
      join(project, ".mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "l" }, broken: {} } }),
    );

    const cwd = join(project, "pkg", "deep");
    const spec = mcpServersSpec({ cwd, projectRoot: project });
    expect(spec.layers.map((layer) => layer.path)).toEqual([
      join(home, "mcp.json"),
      join(home, "config.json"),
      join(home, "mimir.toml"),
      join(project, "mimir.toml"),
      join(project, "pkg", "mimir.toml"),
      join(project, "pkg", "deep", "mimir.toml"),
      join(project, ".mcp.json"),
    ]);

    const { value, reports } = await loadResource(spec);
    expect(value).toEqual({
      global: { command: "g" },
      shadowed: { command: "new" },
      removed: null,
      machine: { command: "m" },
      pkg: { type: "http", url: "https://p" },
      local: { command: "l" },
    });
    const problems = reports.flatMap((r) => r.errors);
    expect(problems).toEqual(["broken: stdio server needs a command"]);
  });
});

describe("plugins and project root", () => {
  test("project root is the nearest .git ancestor, else cwd", async () => {
    expect(await findProjectRoot(join(project, "pkg", "deep"))).toBe(project);
    const loose = join(root, "loose");
    await mkdir(loose, { recursive: true });
    expect(await findProjectRoot(loose)).toBe(loose);
  });

  test(".mimir/ is a plugin; .mimir/plugins/* are more", async () => {
    expect(await discoverLocalPlugins(project)).toEqual([]);
    await mkdir(join(project, ".mimir", "plugins", "extra"), {
      recursive: true,
    });
    await writeFile(join(project, ".mimir", "plugins", "stray.md"), "");
    expect(await discoverLocalPlugins(project)).toEqual([
      { type: "local", path: join(project, ".mimir"), skipMcpDiscovery: true },
      {
        type: "local",
        path: join(project, ".mimir", "plugins", "extra"),
        skipMcpDiscovery: true,
      },
    ]);
  });
});
