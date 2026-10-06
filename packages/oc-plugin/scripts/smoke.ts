#!/usr/bin/env bun
/** V2 startup + hook smoke. All state and HTTP endpoints are disposable. */
// biome-ignore-all lint/suspicious/noExplicitAny: partial host protocol mock; deliberately fails on unexpected capabilities.
import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCartIndex } from "@mimir/plugin-core/store/cart-index";
import { createOrgReplica } from "@mimir/plugin-core/store/org-replica";
import { Message } from "@opencode/ai";

const home = await mkdtemp(join(tmpdir(), "mimir-oc-v2-smoke-"));
process.env.MIMIR_HOME = home;
process.env.MIMIR_ORG_REPLICA_DB = join(home, "org.db");
process.env.MIMIR_CART_INDEX_DB = join(home, "cart.db");
process.env.MIMIR_ANCHOR_INTERVAL = "2";
delete process.env.MIMIR_ACTIVE;
delete process.env.MIMIR_API_KEY;
// Also isolate OpenCode config discovery and any embedder health probe.
process.env.XDG_CONFIG_HOME = join(home, "xdg");

const requests: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    requests.push(path);
    if (path === "/v1/projects/resolve")
      return Response.json({ id: "proj-smoke", localPath: home });
    if (path === "/v1/chat/completions")
      return Response.json({
        choices: [{ message: { content: '["smoke fact extracted locally"]' } }],
      });
    return new Response("not found", { status: 404 });
  },
});
const serverUrl = `http://127.0.0.1:${server.port}`;
process.env.MIMIR_EXTRACTION_BASE_URL = serverUrl;
process.env.MIMIR_EXTRACTION_MODEL = "smoke-model";
process.env.MIMIR_EMBEDDER_PORT = String(server.port);

const transcript = [
  {
    id: "u1",
    type: "user",
    text: "How does the gateway service handle large aggregation queries when the timeout is set too low for ClickHouse?",
  },
  {
    id: "a1",
    type: "assistant",
    content: [
      {
        type: "text",
        text: "The gateway proxy timeout was thirty seconds which is too low for large aggregations. We raised it to one hundred twenty seconds and added a per-query timeout parameter.",
      },
      {
        type: "tool",
        id: "call-1",
        name: "read",
        state: { status: "completed", input: { path: join(home, "x.ts") } },
      },
    ],
  },
  {
    id: "u2",
    type: "user",
    text: "That fixed it, thanks. Write that down for next time.",
  },
];

function mockContext(directory = home) {
  const sessionHooks = new Map<string, (event: any) => any>();
  const toolHooks = new Map<string, (event: any) => any>();
  const tools = new Map<string, any>();
  let signal: AbortSignal | undefined;
  const registration = { dispose: async () => {} };
  const ctx: any = {
    location: {
      directory,
      project: { id: "proj-smoke", directory: home, canonical: home },
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({
        id: sessionID,
        agent: "mimir",
        ...(sessionID === "worker" ? { parentID: "sess-smoke" } : {}),
      }),
      context: async () => transcript,
      hook: async (name: string, hook: (event: any) => any) => {
        assert(!sessionHooks.has(name), `duplicate session hook: ${name}`);
        sessionHooks.set(name, hook);
        return registration;
      },
    },
    tool: {
      transform: async (transform: (editor: any) => void) => {
        transform({
          add: (definition: any) => tools.set(definition.name, definition),
        });
        return registration;
      },
      hook: async (name: string, hook: (event: any) => any) => {
        assert(!toolHooks.has(name), `duplicate tool hook: ${name}`);
        toolHooks.set(name, hook);
        return registration;
      },
    },
    event: {
      async *subscribe(options: { signal: AbortSignal }) {
        signal = options.signal;
        await new Promise<void>((resolve) => {
          if (options.signal.aborted) resolve();
          else
            options.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
      },
    },
  };
  const invoke = async (
    hooks: Map<string, (event: any) => any>,
    name: string,
    event: any,
  ) => {
    const hook = hooks.get(name);
    assert(hook, `missing hook: ${name}`);
    await hook(event);
  };
  return {
    ctx,
    tools,
    sessionHooks,
    toolHooks,
    invoke,
    get signal() {
      return signal;
    },
  };
}

let cleanup: (() => void) | undefined;
try {
  const entry = Bun.argv.includes("--built")
    ? "../dist/mimir-oc.ts"
    : "../src/index.ts";
  const pluginModule = await import(entry);
  const plugin = pluginModule.default;
  assert.equal(plugin.id, "mimir");
  assert.equal(typeof plugin.setup, "function");
  assert.equal(plugin, pluginModule.MimirPlugin);

  const fresh = mockContext();
  await plugin.setup(fresh.ctx);
  assert.deepEqual([...fresh.tools.keys()], ["mimir_install"]);
  assert.equal(typeof fresh.tools.get("mimir_install").execute, "function");
  assert.equal(fresh.sessionHooks.size, 0);
  assert.equal(fresh.signal, undefined);
  console.log("PASS V2 definition + config-missing install registration");

  const prompt =
    "# Identity and Voice\n\n## Voice in Action\n\n**Test:**\n\n> Developer: Ship it.\n>\n> Mimir: Aye.\n\n## Voice Principles\n\nStay grounded.";
  await writeFile(join(home, "system-prompt.md"), prompt);
  await writeFile(
    join(home, "config.json"),
    JSON.stringify({
      serverUrl,
      userMemoryDb: join(home, "user.db"),
      localCartographerPath: join(home, "missing-cartographer"),
    }),
  );
  await mkdir(join(home, ".claude/rules"), { recursive: true });
  await writeFile(
    join(home, ".claude/rules/smoke.md"),
    '---\npaths: ["*.ts"]\n---\n# Smoke rule\nNo classes.\n',
  );
  await writeFile(
    join(home, ".claude/rules/smoke.enforce.toml"),
    `id = "smoke/no-class"
body = "./smoke.md"
enabled = true
severity = "block"
event = "file"
message = "TypeScript classes are denied by smoke rule"
[[conditions]]
field = "new_text"
operator = "regex_match"
pattern = 'class SongSource'
`,
  );
  await writeFile(join(home, "x.ts"), "export const smokeFn = 1;\n");
  const index = createCartIndex(process.env.MIMIR_CART_INDEX_DB);
  index.syncFiles(
    home,
    [
      {
        path: "x.ts",
        language: "typescript",
        content_hash: "smoke-hash",
        imports: [],
        exports: ["smokeFn"],
        symbols: [{ kind: "const", name: "smokeFn", line: 1, column: 0 }],
      },
    ],
    "replace",
  );
  index.close();

  const nestedDirectory = join(home, "packages/api");
  await mkdir(nestedDirectory, { recursive: true });
  const host = mockContext(nestedDirectory);
  cleanup = await plugin.setup(host.ctx);
  assert.equal(typeof cleanup, "function");
  assert.deepEqual([...host.sessionHooks.keys()].sort(), [
    "compaction",
    "context",
    "generate",
    "prompt",
    "title",
  ]);
  assert.deepEqual([...host.toolHooks.keys()].sort(), [
    "execute.after",
    "execute.before",
  ]);
  for (const name of [
    "mimir_install",
    "user_memory_search",
    "user_memory_store",
    "user_profile_get",
    "mimir_delegate",
  ]) {
    assert.equal(typeof host.tools.get(name)?.execute, "function", name);
    assert(host.tools.get(name)?.input, `${name} must use a V2 input schema`);
  }
  for (const name of ["generate", "title"]) {
    const event = {
      sessionID: "sess-smoke",
      system: [{ type: "text", text: "host prompt" }],
    };
    await host.invoke(host.sessionHooks, name, event);
    assert(event.system.some((part) => part.text === prompt));
    assert.equal(
      event.system.filter((part) => part.text.includes("<environment>")).length,
      1,
    );
    assert(
      event.system.some((part) => part.text.includes("@RageLtd/mimir-oc")),
    );
  }
  console.log("PASS V2 hooks, tools, and system text parts");

  for (let turn = 1; turn <= 2; turn++) {
    const admission = {
      sessionID: "sess-smoke",
      messageID: `turn-${turn}`,
      prompt: { text: `question ${turn}` },
      delivery: "steer",
      metadata: {},
    };
    await host.invoke(host.sessionHooks, "prompt", admission);
    // Duplicate admission must not advance the anchor twice.
    await host.invoke(host.sessionHooks, "prompt", admission);
    const request = {
      sessionID: admission.sessionID,
      system: [],
      messages: [
        Message.make({
          id: admission.messageID,
          role: "user",
          content: [Message.text(admission.prompt.text)],
        }),
      ],
    };
    await host.invoke(host.sessionHooks, "context", request);
    assert.equal(request.system[0].text, prompt);
    assert.equal(
      request.system.filter((part) => part.text.includes("<environment>"))
        .length,
      1,
    );
    const text = request.messages
      .flatMap((m) =>
        m.content.filter((p) => p.type === "text").map((p) => p.text),
      )
      .join("\n");
    assert.equal(text.includes("<boot_context>"), turn === 1);
    assert.equal(text.includes("<voice_anchor>"), turn === 2);
    const repeat = {
      ...request,
      messages: [
        Message.make({ role: "user", content: [Message.text("continuation")] }),
      ],
    };
    await host.invoke(host.sessionHooks, "context", repeat);
    assert(!JSON.stringify(repeat.messages).includes("<voice_anchor>"));
  }
  console.log("PASS boot context and retry-safe persona anchor cadence");

  const before = (file: string) => ({
    sessionID: "sess-smoke",
    id: "edit-1",
    tool: "edit",
    input: {
      path: file,
      oldString: "",
      newString: "class SongSource {}",
    },
  });
  await host.invoke(host.toolHooks, "execute.before", before("../../x.py"));
  await assert.rejects(
    () => host.invoke(host.toolHooks, "execute.before", before("../../x.ts")),
    /TypeScript classes are denied/,
  );
  await host.invoke(host.toolHooks, "execute.before", {
    sessionID: "sess-smoke",
    id: "shell-1",
    tool: "shell",
    input: { command: "true" },
  });
  const patch = (file: string) => ({
    sessionID: "sess-smoke",
    id: "patch-1",
    tool: "patch",
    input: {
      patchText: `*** Begin Patch\n*** Add File: ${join(home, file)}\n+class SongSource {}\n*** End Patch`,
    },
  });
  await host.invoke(host.toolHooks, "execute.before", patch("added.py"));
  await assert.rejects(
    () => host.invoke(host.toolHooks, "execute.before", patch("added.ts")),
    /TypeScript classes are denied/,
  );
  console.log("PASS rule scope: Python allowed, TypeScript denied");

  await assert.rejects(
    () =>
      host.invoke(host.toolHooks, "execute.before", {
        sessionID: "worker",
        agent: "mimir-impl",
        id: "outside-shell",
        tool: "shell",
        input: { command: "rm -rf victim", workdir: "/outside" },
      }),
    /outside this agent's worktree/,
  );
  await assert.rejects(
    () =>
      host.invoke(host.toolHooks, "execute.before", {
        sessionID: "worker",
        agent: "mimir-impl",
        id: "test-move",
        tool: "patch",
        input: {
          patchText: `*** Begin Patch\n*** Update File: ${join(home, "x.test.ts")}\n*** Move to: ${join(home, "moved.ts")}\n@@\n-old\n+new\n*** End Patch`,
        },
      }),
    /may not modify test files/,
  );
  console.log("PASS native shell workdir and patch move source guards");

  const filePart = {
    type: "file",
    uri: "file:///smoke.png",
    mime: "image/png",
  };
  const after: any = {
    sessionID: "sess-smoke",
    id: "read-1",
    tool: "read",
    input: { path: "../../x.ts" },
    status: "completed",
    result: {
      content: [{ type: "text", text: "file body" }, filePart],
      metadata: { smoke: true },
      output: { preserved: true },
    },
  };
  await host.invoke(host.toolHooks, "execute.after", after);
  assert(JSON.stringify(after.result.content).includes("<file_context"));
  assert(JSON.stringify(after.result.content).includes("smokeFn"));
  assert(JSON.stringify(after.result.content).includes("# Smoke rule"));
  assert.deepEqual(after.result.metadata, { smoke: true });
  assert.deepEqual(after.result.output, { preserved: true });
  assert.deepEqual(after.result.content[1], filePart);
  assert(!requests.includes("/v1/cartographer/file-info"));
  console.log(
    "PASS structured read result augmented from real local cart index",
  );

  await host.invoke(host.sessionHooks, "compaction", {
    sessionID: "sess-smoke",
    system: [],
    messages: [],
  });
  const replica = createOrgReplica(process.env.MIMIR_ORG_REPLICA_DB);
  const hits = replica.searchByText("smoke fact", 5);
  replica.close();
  assert(
    hits.some((memory) =>
      memory.content.includes("smoke fact extracted locally"),
    ),
  );
  assert(requests.includes("/v1/chat/completions"));
  console.log(
    "PASS compaction extracts V2 persisted records into local replica",
  );

  assert(host.signal && !host.signal.aborted);
  cleanup?.();
  cleanup = undefined;
  assert(host.signal.aborted);
  console.log("PASS unload aborts the event subscription");
  console.log("ALL V2 SMOKE CHECKS PASSED");
} finally {
  cleanup?.();
  server.stop(true);
  await rm(home, { recursive: true, force: true });
}
