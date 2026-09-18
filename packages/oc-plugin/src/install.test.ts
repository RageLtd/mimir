import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import opencodeTemplate from "../artifacts/opencode.json.template" with {
  type: "text",
};
import { readConfig, writeConfig } from "./config";
import { MimirPlugin } from "./index";
import { installMimir } from "./install";

let root: string;
let savedHome: string | undefined;
let savedMimirHome: string | undefined;

/** MIM-41: the same role pinned in both host namespaces, with values
 *  only one host understands — "opus" is a Claude Code alias OpenCode
 *  cannot resolve, so it must never reach an OpenCode agent file. */
const OPENCODE_IMPL_MODEL = "anthropic/claude-opus-4";
const OPENCODE_TEST_MODEL = "ollama/qwen3";
const CLAUDE_CODE_IMPL_MODEL = "opus";

const noCartographer = {
  installEmbedderArtifacts: async () => null,
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
      workerModels: {
        claudeCode: { impl: CLAUDE_CODE_IMPL_MODEL },
        opencode: { impl: OPENCODE_IMPL_MODEL },
      },
    });
    // The user-level mimir.toml overrides config.json per role — the
    // installer renders global agent files, so only the user layer applies.
    await Bun.write(
      join(root, ".mimir", "mimir.toml"),
      `[workers.models.opencode]\ntest = ${JSON.stringify(OPENCODE_TEST_MODEL)}\n`,
    );

    spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ content: "# Mimir", version: "test-version" }),
    );

    const result = await installMimir(
      {
        serverUrl: "https://mimir.example.com/",
        apiKey: "test-key",
      },
      noCartographer,
    );

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

    // The installer has to read the opencode namespace: dropping the
    // host argument, or reading claudeCode, still writes agent files —
    // only their model keys give it away.
    const workerAgent = (name: string) =>
      Bun.file(join(opencodeDir, "agents", `${name}.md`)).text();
    const [impl, tester, review] = await Promise.all([
      workerAgent("mimir-impl"),
      workerAgent("mimir-test"),
      workerAgent("mimir-review"),
    ]);

    expect(impl).toContain(`model: ${JSON.stringify(OPENCODE_IMPL_MODEL)}`);
    expect(tester).toContain(`model: ${JSON.stringify(OPENCODE_TEST_MODEL)}`);
    expect(review).not.toContain("model:");
    for (const agent of [impl, tester, review]) {
      expect(agent).not.toContain(
        `model: ${JSON.stringify(CLAUDE_CODE_IMPL_MODEL)}`,
      );
    }
    expect(
      await Bun.file(join(root, ".local", "bin", "mimir-opencode")).text(),
    ).toContain(runtime);
    expect(await Bun.file(join(root, ".local", "bin", "mimir")).exists()).toBe(
      false,
    );
  });

  test("does not install the operator-only server MCP for tenants", () => {
    expect(opencodeTemplate).not.toContain("/mcp");
    expect(opencodeTemplate).not.toContain("MIMIR_API_KEY");
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
        installEmbedderArtifacts: async () => null,
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

  test("installs the pinned embedder artifacts", async () => {
    let installed = false;

    spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ content: "# Mimir", version: "test-version" }),
    );

    const result = await installMimir(
      {
        serverUrl: "https://mimir.example.com",
        apiKey: "test-key",
      },
      {
        ...noCartographer,
        installEmbedderArtifacts: async () => {
          installed = true;
          return null;
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(installed).toBe(true);
    expect(result.message).toContain("Embedder: artifacts ready");
  });

  test("fails loudly when embedder acquisition fails", async () => {
    spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ content: "# Mimir", version: "test-version" }),
    );

    const result = await installMimir(
      {
        serverUrl: "https://mimir.example.com",
        apiKey: "test-key",
      },
      {
        ...noCartographer,
        installEmbedderArtifacts: async () =>
          new Error("artifact mirror unavailable"),
      },
    );

    expect(result.ok).toBe(false);
    expect(result.message).toBe(
      "Embedder install failed: artifact mirror unavailable",
    );
  });
});
