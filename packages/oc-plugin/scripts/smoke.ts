#!/usr/bin/env bun
/**
 * Live smoke for the OpenCode plugin — loads the REAL plugin entry and
 * drives each hook against a local stub mimir-server, asserting the
 * runtime behaviours the type system can't prove:
 *
 *   1. persona appears in the system prompt
 *   2. voice anchor injects on cadence into the recency slot (as a text
 *      part on the last user message)
 *   3. <file_context> appears after a `read`
 *   4. the compacting hook distills the session into the LOCAL replica
 *      (MIM-86) via the stubbed extraction endpoint
 *   5. reindex on file.edited degrades gracefully with no cartographer binary
 *
 * No network to prod: MIMIR_HOME points at a throwaway dir, serverUrl
 * points at the in-process stub (project resolve + cartographer +
 * extraction chat/completions), and the org replica is a temp SQLite.
 * Run: `bun packages/oc-plugin/scripts/smoke.ts`.
 */

// biome-ignore-all lint/suspicious/noExplicitAny: this harness simulates
// OpenCode's PluginInput and hook-input protocol shapes, constructing only
// the fields the hooks read — the full runtime types are the host's contract.

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attempt } from "@mimir/plugin-core/result";

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") =>
  results.push({ name, ok, detail });

// ── Stub mimir-server (+ extraction endpoint) ──
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    await req.json().catch(() => ({}));
    if (url.pathname === "/v1/projects/resolve") {
      return Response.json({ id: "proj-smoke", localPath: "/tmp/x" });
    }
    if (url.pathname === "/v1/cartographer/file-info") {
      return Response.json({
        contentHash: "hash-1",
        symbols: [{ kind: "const", name: "smokeFn", line: 7 }],
        imports: [],
        dependents: [],
        memories: null,
      });
    }
    // MIM-86: local extraction dials an OpenAI-compatible endpoint —
    // the stub returns one canned memory.
    if (url.pathname === "/v1/chat/completions") {
      return Response.json({
        choices: [{ message: { content: '["smoke fact extracted locally"]' } }],
      });
    }
    return new Response("not found", { status: 404 });
  },
});
const serverUrl = `http://localhost:${server.port}`;

// ── Temp MIMIR_HOME with config + real system prompt ──
const home = await mkdtemp(join(tmpdir(), "mimir-oc-smoke-"));
process.env.MIMIR_HOME = home;
process.env.MIMIR_ANCHOR_INTERVAL = "2"; // anchor fires on turn 2, after boot
// MIM-86 local distillation: extraction dials the stub, replica is a temp
// SQLite. Embedder defaults apply — warm llama-server embeds for real,
// cold degrades to unembedded stores (backfill's job).
process.env.MIMIR_EXTRACTION_BASE_URL = serverUrl;
process.env.MIMIR_EXTRACTION_MODEL = "smoke-model";
process.env.MIMIR_ORG_REPLICA_DB = join(home, "org-replica.db");
await writeFile(
  join(home, "config.json"),
  JSON.stringify({ serverUrl, userMemoryDb: join(home, "mem.db") }),
);
// Copy the installed persona prompt so voice anchors parse from the real thing.
const realPrompt = Bun.file(
  join(process.env.HOME ?? "", ".mimir/system-prompt.md"),
);
const promptText = (await realPrompt.exists())
  ? await realPrompt.text()
  : "# Mimir\n\n<voice_in_action>\n\n**Test:**\n\n> Mimir: Aye.\n\n</voice_in_action>";
await writeFile(join(home, "system-prompt.md"), promptText);

// ── Fake OpenCode ctx ──
const userMsg = (id: string, text: string) => ({
  info: { id, sessionID: "sess-smoke", role: "user" },
  parts: [
    {
      id: `${id}-p`,
      sessionID: "sess-smoke",
      messageID: id,
      type: "text",
      text,
    },
  ],
});
const assistantMsg = (id: string, text: string) => ({
  info: { id, sessionID: "sess-smoke", role: "assistant" },
  parts: [
    {
      id: `${id}-t`,
      sessionID: "sess-smoke",
      messageID: id,
      type: "text",
      text,
    },
    {
      id: `${id}-tool`,
      sessionID: "sess-smoke",
      messageID: id,
      type: "tool",
      callID: "c1",
      name: "read",
      input: { filePath: "/x.ts" },
    },
  ],
});
// Two user turns and enough rendered text to clear the extraction gates
// (≥2 user turns, ≥200 chars).
const transcriptFixture = [
  userMsg(
    "u1",
    "my real question about how the gateway service handles large aggregation queries when the timeout is set too low for ClickHouse",
  ),
  assistantMsg(
    "a1",
    "the gateway proxy timeout was thirty seconds which is too low for large aggregations — raised it to one hundred twenty seconds and added a per-query timeout parameter",
  ),
  userMsg("u2", "that fixed it, thanks — write that down for next time"),
];

const ctx = {
  directory: home,
  client: {
    session: {
      messages: async () => ({ data: transcriptFixture, error: undefined }),
    },
  },
};

const { MimirPlugin } = await import("../src/index.ts");
const hooks = await MimirPlugin(ctx as any);

// ── 1. Persona in system prompt ──
const sysOut = { system: ["opencode default prompt"] };
await hooks["experimental.chat.system.transform"]?.(
  { model: {} } as any,
  sysOut,
);
check(
  "persona appears in system prompt",
  sysOut.system.length === 2 && sysOut.system[1] === promptText,
  `system[] length=${sysOut.system.length}`,
);

// ── 2. Voice anchor cadence into recency slot ──
const anchorTexts: string[] = [];
for (let turn = 1; turn <= 2; turn++) {
  await hooks["chat.message"]?.({ sessionID: "sess-smoke" } as any, {} as any);
  const messages = [userMsg(`turn${turn}`, `question ${turn}`)];
  await hooks["experimental.chat.messages.transform"]?.({} as any, {
    messages,
  });
  // Injected parts land at the FRONT of the last user message.
  const injected = messages[0].parts
    .filter((p: { type: string }) => p.type === "text")
    .map((p: { text: string }) => p.text);
  anchorTexts.push(...injected);
}
const sawBoot = anchorTexts.some(
  (t) => t.includes("<conversation_context>") || t.includes("<user_"),
);
const sawAnchor = anchorTexts.some((t) => t.includes("<voice_anchor>"));
check(
  "boot context injected on first turn",
  sawBoot,
  `blocks: ${anchorTexts.length}`,
);
check("voice anchor injected on cadence (interval=2)", sawAnchor, "");

// ── 3. <file_context> after a read ──
const readOut = { title: "x.ts", output: "the file body", metadata: {} };
await hooks["tool.execute.after"]?.(
  {
    tool: "read",
    sessionID: "sess-smoke",
    callID: "c1",
    args: { filePath: "/x.ts" },
  } as any,
  readOut,
);
check(
  "<file_context> appended after read",
  readOut.output.includes("<file_context") &&
    readOut.output.includes("smokeFn"),
  "",
);

// ── 4. Compacting hook distills into the LOCAL replica (MIM-86) ──
await hooks["experimental.session.compacting"]?.(
  { sessionID: "sess-smoke" } as any,
  {
    context: [],
  } as any,
);
const { createOrgReplica } = await import(
  "@mimir/plugin-core/store/org-replica"
);
const replica = createOrgReplica(process.env.MIMIR_ORG_REPLICA_DB ?? "");
const distilled = replica.searchByText("smoke fact", 5);
replica.close();
check(
  "compacting hook distills session into local replica",
  distilled.length > 0 &&
    distilled.some((m) => m.content.includes("smoke fact")),
  `replica hits: ${distilled.length}`,
);

// ── 5. Reindex degrades gracefully with no cartographer binary ──
const [editErr] = await attempt(async () =>
  hooks.event?.({
    event: { type: "file.edited", properties: { file: "x.ts" } },
  } as any),
);
const [createErr] = await attempt(async () =>
  hooks.event?.({ event: { type: "session.created", properties: {} } } as any),
);
check(
  "reindex events handled without crash (no binary)",
  !editErr && !createErr,
  "",
);

// ── Report ──
server.stop(true);
console.log("\n─── oc-plugin live smoke ───");
let allOk = true;
for (const r of results) {
  const mark = r.ok ? "PASS" : "FAIL";
  if (!r.ok) allOk = false;
  console.log(`  [${mark}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
}
console.log(allOk ? "\nALL SMOKE CHECKS PASSED" : "\nSMOKE FAILURES ABOVE");
process.exit(allOk ? 0 : 1);
