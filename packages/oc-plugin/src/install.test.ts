import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig } from "./config";
import { MimirPlugin } from "./index";
import { installMimir } from "./install";

let root: string;
let savedHome: string | undefined;
let savedMimirHome: string | undefined;

const noCartographer = {
  resolveCartographerBinary: async () => ({
    ok: true as const,
    binary: null,
    reason: "not found",
  }),
};

beforeEach(async () => {
  savedHome = process.env.HOME;
  savedMimirHome = process.env.MIMIR_HOME;
  root = await mkdtemp(join(tmpdir(), "mimir-oc-install-"));
  process.env.HOME = root;
  process.env.MIMIR_HOME = join(root, ".mimir");
  await mkdir(process.env.MIMIR_HOME, { recursive: true });
});

afterEach(async () => {
  mock.restore();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedMimirHome === undefined) delete process.env.MIMIR_HOME;
  else process.env.MIMIR_HOME = savedMimirHome;
  await rm(root, { recursive: true, force: true });
});

describe("installMimir", () => {
  test("exposes mimir_install before shared config exists", async () => {
    const hooks = await Reflect.apply(MimirPlugin, undefined, []);

    expect(Object.keys(hooks.tool ?? {})).toEqual(["mimir_install"]);
  });

  test("preserves OpenCode registration and bootstraps reusable commands", async () => {
    const opencodeDir = join(root, ".config", "opencode");
    const opencodeConfig = join(opencodeDir, "opencode.jsonc");
    const existingOpenCode = '{"plugin":["@RageLtd/mimir-oc"]}\n';
    await mkdir(opencodeDir, { recursive: true });
    await Bun.write(opencodeConfig, existingOpenCode);
    await writeConfig({
      serverUrl: "https://old.example.com",
      userMemoryDb: join(root, ".mimir", "user-memories.db"),
      extractionBaseUrl: "http://ollama.local",
      extractionModel: "ornith:35b",
    });

    spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ content: "# Mimir", version: "test-version" }),
    );

    const result = await installMimir({
      serverUrl: "https://mimir.example.com/",
      apiKey: "test-key",
    }, noCartographer);

    expect(result.ok).toBe(true);
    expect(await Bun.file(opencodeConfig).text()).toBe(existingOpenCode);
    expect(await Bun.file(join(opencodeDir, "opencode.json")).exists()).toBe(
      false,
    );

    const config = await readConfig();
    expect(config?.serverUrl).toBe("https://mimir.example.com");
    expect(config?.extractionBaseUrl).toBe("http://ollama.local");
    expect(config?.extractionModel).toBe("ornith:35b");

    const runtime = join(root, ".mimir", "mimir-oc.ts");
    expect(await Bun.file(runtime).exists()).toBe(true);
    expect(
      await Bun.file(
        join(opencodeDir, "commands", "mimir-install.md"),
      ).exists(),
    ).toBe(true);
    expect(
      await Bun.file(join(opencodeDir, "commands", "mimir-update.md")).exists(),
    ).toBe(true);
    expect(
      await Bun.file(join(opencodeDir, "agents", "mimir.md")).exists(),
    ).toBe(true);
    expect(await Bun.file(join(root, ".local", "bin", "mimir")).text()).toContain(
      runtime,
    );
  });

  test("persists the Cartographer path returned by automatic resolution", async () => {
    const cartographer = join(root, ".local", "bin", "cartographer");

    spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ content: "# Mimir", version: "test-version" }),
    );

    const result = await installMimir(
      {
        serverUrl: "https://mimir.example.com",
        apiKey: "test-key",
      },
      {
        resolveCartographerBinary: async () => ({
          ok: true as const,
          binary: cartographer,
        }),
      },
    );

    expect(result.ok).toBe(true);
    expect((await readConfig())?.cartographerBinary).toBe(cartographer);
    expect(result.message).toContain(`Cartographer: ${cartographer}`);
  });
});
