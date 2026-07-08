/**
 * Local hygiene sweep (MIM-86) — the server's consolidate/contradict/forget
 * passes relocated over the replica. Judgment model = the user-chosen
 * extraction endpoint (same trio, same transport via completeChat).
 *
 * Parity notes:
 * - Union-find clustering, forgetting score, thresholds, and both system
 *   prompts are VERBATIM ports of goldfish/hygiene/* + config defaults.
 * - Merges express as delete+delete+create (LWW-sync constraint from the
 *   ticket) — never an in-place update of a survivor.
 * - Dry-run by default, like the server: destructive passes opt in.
 * - Org-level concurrency (server-issued lease) is deferred to MIM-88 —
 *   single-member replicas have nobody to race.
 * - "Untouched since last sweep" needs a previous-sweep timestamp; the
 *   caller owns that state (cc-plugin keeps it in ~/.mimir) and passes
 *   `lastSweepMs` — null means first sweep, nothing decays.
 */

import { attempt } from "../result";
import type { OrgReplica } from "../store/org-replica";
import { cosineDistance } from "../store/org-replica";
import { completeChat, type ExtractionConfig } from "./extract";
import type { EmbedQuery } from "./retrieve";

// ── Thresholds: verbatim from server config.hygiene defaults ──

const MERGE_DISTANCE = 0.18;
const MAX_CLUSTER_SIZE = 5;
const MAX_MERGES_PER_SWEEP = 20;
const SCORE_FLOOR = 0.15;
const MIN_AGE_DAYS = 14;
const CONFIDENCE_DECAY = 0.9;
const MAX_PRUNES_PER_SWEEP = 50;
const CONTRADICTION_DISTANCE = 0.3;
const CONTRADICTION_MAX_CHECKS = 20;
const DEMOTION_FACTOR = 0.3;

const HYGIENE_MAX_TOKENS = 8192;
const HYGIENE_TIMEOUT_MS = 120_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const HALF_LIFE_DAYS = 30;
const ACCESS_SATURATION_K = 3;

// ── Prompts: verbatim from server goldfish/hygiene/llm.ts ──

const MERGE_SYSTEM_PROMPT = `You consolidate overlapping development memories into one.

You are given several short factual statements that describe the SAME thing in slightly different words or from slightly different angles. Fuse them into a SINGLE crisp memory that:
- preserves every distinct specific (numbers, names, file paths, decisions, reasons)
- drops only the redundancy between them
- invents NOTHING not present in the inputs
- reads as one standalone fact useful in a FUTURE conversation

Output ONLY the merged statement as plain text. No preamble, no quotes, no JSON, no bullet points.`;

const CLASSIFY_SYSTEM_PROMPT = `You compare two development memories that are close in topic and choose ONE action describing how they relate.

- "merge": they are about the SAME thing and should be fused into one memory with NO loss — either redundant restatements, or one updates/supersedes the other while BOTH still carry detail worth keeping (e.g. an earlier plan or phase plus its later completion; a decision plus its implementation; a status that moved forward). Fusing them keeps every fact and just reconciles the timeline.

- "demote": they make claims that CANNOT both be true — one directly negates, contradicts, or reports a different value than the other, and one is simply WRONG now (e.g. "X has 32GB" vs "X has 128GB"; "we use approach A" vs "A was abandoned for B"; "the fix is in place" vs "that fix was reverted"). Here we keep the correct statement and demote the wrong one. Do NOT pick merge for these — fusing a true claim with a false one would corrupt the record.

- "leave": anything else — they are about different things, or both are independently true and complementary, or you cannot confidently tell.

Decide merge vs demote with this test: if a reader could hold BOTH statements' facts in one coherent memory, choose "merge". If holding both would mean believing something now FALSE, choose "demote". When unsure between demote and leave, choose "leave". When unsure between merge and leave, choose "leave".

For "demote", set survivor to the statement that is correct/current (1 or 2); if you cannot tell which side is right, choose "leave" instead. For "merge" and "leave", survivor is null.

Respond with ONLY a JSON object — no preamble, no markdown fences:
{"action": "merge" | "demote" | "leave", "survivor": 1 | 2 | null, "reason": "<one short sentence>"}`;

// ── Pure: union-find clustering (verbatim port of hygiene/cluster.ts) ──

export type NeighborEdge = {
  readonly a: string;
  readonly b: string;
  readonly distance: number;
};

export const groupClusters = (
  edges: readonly NeighborEdge[],
  opts: { readonly mergeDistance: number; readonly maxClusterSize: number },
) => {
  const parent = new Map<string, string>();

  const find = (x: string) => {
    let root = x;
    while (parent.get(root) !== root) {
      root = parent.get(root) ?? root;
    }
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) ?? root;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };

  const add = (x: string) => {
    if (!parent.has(x)) parent.set(x, x);
  };

  const union = (x: string, y: string) => {
    add(x);
    add(y);
    const rx = find(x);
    const ry = find(y);
    if (rx !== ry) parent.set(rx, ry);
  };

  for (const edge of edges) {
    if (edge.distance > opts.mergeDistance) continue;
    if (edge.a === edge.b) {
      add(edge.a);
      continue;
    }
    union(edge.a, edge.b);
  }

  const groups = new Map<string, string[]>();
  for (const node of parent.keys()) {
    const root = find(node);
    const group = groups.get(root) ?? [];
    group.push(node);
    groups.set(root, group);
  }

  const clusters: string[][] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    clusters.push([...members].sort().slice(0, opts.maxClusterSize));
  }

  return clusters.sort((x, y) => (x[0] ?? "").localeCompare(y[0] ?? ""));
};

// ── Pure: forgetting score (verbatim port of hygiene/score.ts) ──

type ScoreInput = {
  readonly confidence?: number | null;
  readonly last_accessed?: string | null;
  readonly access_count?: number | null;
  readonly created_at?: string | null;
};

const toMs = (iso: string | null | undefined, fallbackMs: number) => {
  if (!iso) return fallbackMs;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? fallbackMs : ms;
};

export const scoreMemory = (input: ScoreInput, nowMs: number) => {
  const confidence = input.confidence ?? 1;
  const accessCount = input.access_count ?? 0;

  const lastAccessedMs = toMs(
    input.last_accessed,
    toMs(input.created_at, nowMs),
  );
  const daysSinceAccess = Math.max(0, (nowMs - lastAccessedMs) / DAY_MS);
  const freshness = Math.exp((-daysSinceAccess * Math.LN2) / HALF_LIFE_DAYS);

  // 0.5 (never accessed) → 1.0 (heavily accessed), saturating.
  const accessFactor =
    0.5 + 0.5 * (accessCount / (accessCount + ACCESS_SATURATION_K));

  return confidence * freshness * accessFactor;
};

// ── LLM judgment calls ──

const mergeMemoriesText = async (
  config: ExtractionConfig,
  contents: readonly string[],
) =>
  completeChat(config, {
    system: MERGE_SYSTEM_PROMPT,
    user: contents.map((c, i) => `${i + 1}. ${c}`).join("\n"),
    maxTokens: HYGIENE_MAX_TOKENS,
    timeoutMs: HYGIENE_TIMEOUT_MS,
  });

type Classification = {
  readonly action: "merge" | "demote" | "leave";
  readonly survivor: 1 | 2 | null;
  readonly reason: string;
};

const classifyPair = async (
  config: ExtractionConfig,
  first: string,
  second: string,
) => {
  const raw = await completeChat(config, {
    system: CLASSIFY_SYSTEM_PROMPT,
    user: `1. ${first}\n2. ${second}`,
    maxTokens: HYGIENE_MAX_TOKENS,
    timeoutMs: HYGIENE_TIMEOUT_MS,
  });
  if (raw === null) return null;
  const [parseErr, parsed] = await attempt(async () => {
    const cleaned = raw.replace(/```json\n?|```/g, "").trim();
    return JSON.parse(cleaned) as Classification;
  });
  if (parseErr || !["merge", "demote", "leave"].includes(parsed.action)) {
    return null;
  }
  return parsed;
};

// ── Sweep driver ──

export type HygieneSweepOpts = {
  readonly replica: OrgReplica;
  readonly config: ExtractionConfig;
  readonly embed: EmbedQuery;
  /** Default TRUE — destructive passes opt in, matching the server. */
  readonly dryRun?: boolean;
  /** Previous sweep's timestamp (ms) — drives untouched-decay. Null on
   *  first sweep: nothing decays. */
  readonly lastSweepMs?: number | null;
  readonly now?: number;
};

type Fact = ReturnType<OrgReplica["listFactsWithEmbeddings"]>[number];

/** delete + delete + create — the LWW-friendly merge shape. */
const applyMerge = async (
  opts: HygieneSweepOpts,
  members: readonly Fact[],
  merged: string,
) => {
  const embedding = await opts.embed(merged);
  const confidence = members.reduce(
    (max, m) => Math.max(max, m.confidence ?? 1),
    0,
  );
  for (const m of members) {
    opts.replica.deleteMemory(m.id);
  }
  const projectId = members.find((m) => m.project_id)?.project_id;
  opts.replica.storeMemory({
    content: merged,
    type: "fact",
    ...(projectId ? { project_id: projectId } : {}),
    ...(embedding ? { embedding } : {}),
  });
  return confidence;
};

export const runLocalHygieneSweep = async (opts: HygieneSweepOpts) => {
  const dryRun = opts.dryRun ?? true;
  const now = opts.now ?? Date.now();
  const facts = opts.replica.listFactsWithEmbeddings();
  const byId = new Map(facts.map((f) => [f.id, f]));

  // Pairwise neighbor edges over the loaded set — one cosine per pair,
  // kept when within the contradiction band ceiling.
  const embedded = facts.filter((f) => f.embedding !== null);
  const edges: NeighborEdge[] = [];
  for (let i = 0; i < embedded.length; i++) {
    const a = embedded[i];
    if (!a?.embedding) continue;
    const va = Float32Array.from(a.embedding);
    for (let j = i + 1; j < embedded.length; j++) {
      const b = embedded[j];
      if (!b?.embedding) continue;
      const distance = cosineDistance(va, Float32Array.from(b.embedding));
      if (distance <= CONTRADICTION_DISTANCE) {
        edges.push({ a: a.id, b: b.id, distance });
      }
    }
  }

  // ── Consolidation ──
  const clusters = groupClusters(edges, {
    mergeDistance: MERGE_DISTANCE,
    maxClusterSize: MAX_CLUSTER_SIZE,
  }).slice(0, MAX_MERGES_PER_SWEEP);

  const consumed = new Set<string>();
  const proposals: {
    members: string[];
    merged: string | null;
    applied: boolean;
  }[] = [];
  for (const cluster of clusters) {
    const members = cluster.flatMap((id) => {
      const fact = byId.get(id);
      return fact ? [fact] : [];
    });
    const merged = await mergeMemoriesText(
      opts.config,
      members.map((m) => m.content),
    );
    let applied = false;
    if (merged && !dryRun) {
      await applyMerge(opts, members, merged);
      applied = true;
    }
    if (merged) for (const id of cluster) consumed.add(id);
    proposals.push({ members: cluster, merged, applied });
  }

  // ── Contradiction: the band ABOVE mergeDistance, disjoint from merges ──
  const bandPairs = edges
    .filter(
      (e) =>
        e.distance > MERGE_DISTANCE && !consumed.has(e.a) && !consumed.has(e.b),
    )
    .sort((x, y) => x.distance - y.distance)
    .slice(0, CONTRADICTION_MAX_CHECKS);

  const contradictions: {
    pair: [string, string];
    action: string;
    applied: boolean;
  }[] = [];
  for (const edge of bandPairs) {
    const a = byId.get(edge.a);
    const b = byId.get(edge.b);
    if (!a || !b) continue;
    const verdict = await classifyPair(opts.config, a.content, b.content);
    if (!verdict) continue;
    let applied = false;
    if (!dryRun && verdict.action === "merge") {
      const merged = await mergeMemoriesText(opts.config, [
        a.content,
        b.content,
      ]);
      if (merged) {
        await applyMerge(opts, [a, b], merged);
        applied = true;
      }
    }
    if (!dryRun && verdict.action === "demote" && verdict.survivor !== null) {
      const loser = verdict.survivor === 1 ? b : a;
      applied = opts.replica.setConfidence(
        loser.id,
        (loser.confidence ?? 1) * DEMOTION_FACTOR,
      );
    }
    contradictions.push({
      pair: [edge.a, edge.b],
      action: verdict.action,
      applied,
    });
  }

  // ── Forgetting: decay untouched, prune below the floor ──
  let decayed = 0;
  const pruneInputs = facts.map((f) => {
    const lastMs = toMs(f.last_accessed, toMs(f.created_at, now));
    const untouched = opts.lastSweepMs != null && lastMs < opts.lastSweepMs;
    const confidence = (f.confidence ?? 1) * (untouched ? CONFIDENCE_DECAY : 1);
    if (untouched && !dryRun && opts.replica.setConfidence(f.id, confidence)) {
      decayed++;
    }
    return { ...f, confidence };
  });

  const pruneCandidates = pruneInputs
    .flatMap((f) => {
      const ageDays = (now - toMs(f.created_at, now)) / DAY_MS;
      if (ageDays < MIN_AGE_DAYS) return [];
      const score = scoreMemory(f, now);
      if (score >= SCORE_FLOOR) return [];
      return [{ id: f.id, content: f.content, score, ageDays }];
    })
    .sort((x, y) => x.score - y.score)
    .slice(0, MAX_PRUNES_PER_SWEEP);

  let pruned = 0;
  if (!dryRun) {
    for (const candidate of pruneCandidates) {
      if (opts.replica.deleteMemory(candidate.id)) pruned++;
    }
  }

  return {
    dryRun,
    model: opts.config.model,
    facts: facts.length,
    edges: edges.length,
    clustersFound: clusters.length,
    proposals,
    contradictions,
    decayed,
    pruneCandidates,
    pruned,
  };
};
