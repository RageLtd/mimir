/**
 * SDK SessionStore probe.
 *
 * One-shot empirical capture of what the Claude Agent SDK actually writes
 * to a `SessionStore` adapter — and what it asks `load()` to return on
 * resume. Drives the design of mimir-acp's own SessionStore implementation
 * by giving us ground-truth fixtures instead of guessing at the @alpha
 * `SessionStoreEntry` shape.
 *
 * Run from the mimir repo root:
 *   bun run packages/acp/scripts/sdk-session-store-probe.ts
 *
 * Auth: relies on $CLAUDE_CODE_OAUTH_TOKEN being in process env (the SDK
 * picks it up automatically). Falls back to $ANTHROPIC_API_KEY if set.
 *
 * Output: `/tmp/mimir-cc-probe/fixture.json` — full append/load capture +
 * usage stats. Hand-inspect, then snapshot-test the SessionStore module
 * against it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  query,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

// Probe-isolated CC config dir so we don't drop transcripts into ~/.claude
// alongside the user's real CC sessions.
const PROBE_CONFIG_DIR = join(tmpdir(), `mimir-cc-probe-${process.pid}`);
const OUTPUT_DIR = join(tmpdir(), "mimir-cc-probe");
const FIXTURE_PATH = join(OUTPUT_DIR, "fixture.json");

type AppendCall = {
  readonly turn: number;
  readonly callIndex: number;
  readonly key: SessionKey;
  readonly entries: readonly SessionStoreEntry[];
};

type LoadCall = {
  readonly turn: number;
  readonly key: SessionKey;
  readonly returned: readonly SessionStoreEntry[] | null;
};

type TurnSummary = {
  readonly turn: number;
  readonly sessionId?: string;
  readonly stopReason?: string;
  readonly inputTokens?: number;
  readonly cacheReadTokens?: number;
  readonly cacheCreateTokens?: number;
  readonly outputTokens?: number;
  readonly costUsd?: number;
  readonly contextWindow?: number;
};

const appendCalls: AppendCall[] = [];
const loadCalls: LoadCall[] = [];
const turnSummaries: TurnSummary[] = [];

// Single shared store across both turns — turn 2's load() must see what
// turn 1's append() wrote.
const store = new Map<string, SessionStoreEntry[]>();
const keyOf = (k: SessionKey) =>
  `${k.projectKey}::${k.sessionId}::${k.subpath ?? ""}`;

let currentTurn = 0;
let appendCallCounter = 0;

const probeStore: SessionStore = {
  async append(key, entries) {
    appendCallCounter += 1;
    appendCalls.push({
      turn: currentTurn,
      callIndex: appendCallCounter,
      key,
      // Deep-clone via JSON round-trip per the SDK contract (we'd do this
      // in a real adapter too — entries are pass-through blobs).
      entries: JSON.parse(JSON.stringify(entries)) as SessionStoreEntry[],
    });
    const k = keyOf(key);
    const prior = store.get(k) ?? [];
    store.set(k, [...prior, ...entries]);
  },
  async load(key) {
    const k = keyOf(key);
    const entries = store.get(k) ?? null;
    loadCalls.push({
      turn: currentTurn,
      key,
      returned: entries
        ? (JSON.parse(JSON.stringify(entries)) as SessionStoreEntry[])
        : null,
    });
    return entries;
  },
};

async function* singleUserMessage(text: string) {
  yield {
    type: "user" as const,
    message: { role: "user" as const, content: text },
    parent_tool_use_id: null,
  };
}

const runTurn = async (
  turn: number,
  prompt: string,
  resumeSessionId?: string,
) => {
  currentTurn = turn;
  const summary: {
    -readonly [K in keyof TurnSummary]: TurnSummary[K];
  } = { turn };

  const q = query({
    prompt: singleUserMessage(prompt),
    options: {
      sessionStore: probeStore,
      // Required: persistSession: false is incompatible with sessionStore.
      persistSession: true,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
      // Probe isolation
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: PROBE_CONFIG_DIR,
      },
      // Allow Read so we can exercise a tool_use cycle on turn 2.
      allowedTools: ["Read"],
      permissionMode: "bypassPermissions",
      includePartialMessages: false,
      settingSources: [],
      skills: [],
      plugins: [],
    },
  });

  for await (const msg of q) {
    if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
      summary.sessionId = msg.session_id;
      continue;
    }
    if (msg.type === "result") {
      summary.sessionId = msg.session_id;
      summary.stopReason = msg.subtype;
      summary.inputTokens = msg.usage?.input_tokens;
      summary.cacheReadTokens = msg.usage?.cache_read_input_tokens;
      summary.cacheCreateTokens = msg.usage?.cache_creation_input_tokens;
      summary.outputTokens = msg.usage?.output_tokens;
      summary.costUsd = msg.total_cost_usd;
      const mu = msg.modelUsage;
      const firstKey = mu ? Object.keys(mu)[0] : undefined;
      if (mu && firstKey) {
        summary.contextWindow = mu[firstKey]?.contextWindow;
      }
    }
  }

  turnSummaries.push(summary);
  return summary;
};

const main = async () => {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(PROBE_CONFIG_DIR, { recursive: true });

  console.error(
    `[probe] auth env vars present: oauth=${!!process.env.CLAUDE_CODE_OAUTH_TOKEN} api_key=${!!process.env.ANTHROPIC_API_KEY}`,
  );
  console.error(`[probe] CLAUDE_CONFIG_DIR=${PROBE_CONFIG_DIR}`);

  // Turn 1: simple text-only round-trip. Establishes baseline entry shape
  // for user/assistant messages with no tool cycle.
  console.error("[probe] turn 1: simple text reply");
  const t1 = await runTurn(
    1,
    "Reply with exactly the word PROBE and nothing else.",
  );
  console.error(`[probe] turn 1 sessionId=${t1.sessionId}`);

  if (!t1.sessionId) {
    throw new Error("[probe] turn 1 produced no sessionId; cannot resume");
  }

  // Turn 2: resume + force a tool_use cycle. This is the boundary case we
  // need for the trim logic — we must never split tool_use from tool_result.
  console.error("[probe] turn 2: resume with tool_use cycle");
  const t2 = await runTurn(
    2,
    "Read the file /etc/hostname and reply with its first line.",
    t1.sessionId,
  );
  console.error(`[probe] turn 2 sessionId=${t2.sessionId}`);

  // Cluster entry types observed across all append() calls.
  const allEntries = appendCalls.flatMap((c) => c.entries);
  const typeBreakdown = allEntries.reduce<Record<string, number>>((acc, e) => {
    acc[e.type] = (acc[e.type] ?? 0) + 1;
    return acc;
  }, {});

  // Sample one entry per type for human inspection.
  const samplesByType: Record<string, SessionStoreEntry> = {};
  for (const e of allEntries) {
    if (!samplesByType[e.type]) samplesByType[e.type] = e;
  }

  const fixture = {
    capturedAt: new Date().toISOString(),
    sdkVersion:
      process.env.CLAUDE_AGENT_SDK_VERSION ?? "unknown (probe context)",
    turnSummaries,
    appendCallCount: appendCalls.length,
    loadCallCount: loadCalls.length,
    totalEntries: allEntries.length,
    typeBreakdown,
    samplesByType,
    appendCalls,
    loadCalls,
  };

  await writeFile(FIXTURE_PATH, JSON.stringify(fixture, null, 2));

  console.error("");
  console.error("=== PROBE RESULTS ===");
  console.error(`fixture: ${FIXTURE_PATH}`);
  console.error(`append() calls: ${appendCalls.length}`);
  console.error(`load() calls: ${loadCalls.length}`);
  console.error(`total entries captured: ${allEntries.length}`);
  console.error("entry type breakdown:");
  for (const [type, count] of Object.entries(typeBreakdown).sort(
    (a, b) => b[1] - a[1],
  )) {
    console.error(`  ${type.padEnd(24)} ${count}`);
  }
  console.error("turn summaries:");
  for (const s of turnSummaries) {
    console.error(
      `  turn ${s.turn} session=${s.sessionId} stop=${s.stopReason} input=${s.inputTokens} cacheRead=${s.cacheReadTokens} output=${s.outputTokens}`,
    );
  }
};

main().catch((err) => {
  console.error("[probe] fatal:", err);
  process.exit(1);
});
