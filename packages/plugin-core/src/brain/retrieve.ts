/**
 * Local retrieval brain (MIM-84) — the client-side port of the server's
 * per-turn retrieval path: goldfish/memory.ts retrieveMemoryList scoring,
 * goldfish/playbook.ts index + ambient trigger match, and the
 * /v1/context/retrieve <retrieved_context> block format. Same constants,
 * same math, same output shape — parity is the contract, so hooks can swap
 * a server round-trip for an in-process call without the model noticing.
 *
 * One deliberate divergence: the server ABORTS retrieval when the query
 * embedding fails (its embedder is config-guaranteed). Locally, no embedder
 * is the NORMAL state until MIM-85 lands llama-server — so a missing/failed
 * `embedQuery` degrades to FTS + freshness + confidence instead of erroring.
 */

import type { OrgReplica, ReplicaMemory } from "../store/org-replica";
import { computeFreshness } from "../store/org-replica";

/** Query embedder seam — MIM-85 plugs the llama-server client in here.
 *  Undefined or a null result means "no vector leg this turn". */
export type EmbedQuery = (text: string) => Promise<number[] | null>;

// ── Scoring constants: verbatim from goldfish/memory.ts ──
const PROJECT_MATCH_BONUS = 0.02;
const VECTOR_WEIGHT = 0.7;
const TEXT_WEIGHT = 0.3;
const SCORE_FLOOR = 0.05;
const NEUTRAL_COMBINED_SCORE = 0.5;
const VECTOR_CANDIDATES = 30;
const TEXT_CANDIDATES = 20;
const RELATED_LIMIT = 5;

// ── Playbook constants: verbatim from goldfish/playbook.ts ──
const INDEX_CAP = 20;
const AMBIENT_TOP_K = 2;
const AMBIENT_MAX_DISTANCE = 0.45;

// ── Retrieve-route defaults: verbatim from routes/context.ts ──
const RETRIEVE_MEMORY_TOP_K = 3;
const RETRIEVE_SUMMARY_COUNT = 3;

export type RetrieveOpts = {
  readonly topK?: number;
  readonly includeRelated?: boolean;
  /** Canonical project UUID — scoring tiebreaker and playbook scope. */
  readonly projectId?: string;
  readonly summaryCount?: number;
  readonly embedQuery?: EmbedQuery;
};

/** Verbatim port of goldfish/memory.ts scoreRetrievalCandidate. */
export const scoreRetrievalCandidate = (opts: {
  readonly combinedScore: number;
  readonly freshness: number;
  readonly confidence: number;
  readonly projectBonus: number;
}) =>
  (opts.combinedScore || NEUTRAL_COMBINED_SCORE) *
    opts.freshness *
    opts.confidence +
  opts.projectBonus;

type Candidate = ReplicaMemory & {
  readonly distance?: number;
  readonly score?: number;
};

/**
 * Port of retrieveMemoryList: hybrid candidates → combined score →
 * freshness/confidence/project weighting → topK above the floor →
 * optional graph hop → touch. Returns memory content strings or null.
 */
export const retrieveMemoryList = async (
  replica: OrgReplica,
  query: string,
  opts: RetrieveOpts = {},
) => {
  if (!query.trim()) return null;
  const topK = opts.topK ?? 10;
  const includeRelated = opts.includeRelated ?? true;

  const queryEmbedding = opts.embedQuery ? await opts.embedQuery(query) : null;

  const vectorResults: Candidate[] = queryEmbedding
    ? replica.searchByVector(queryEmbedding, VECTOR_CANDIDATES)
    : [];
  const textResults: Candidate[] = replica.searchByText(query, TEXT_CANDIDATES);

  const seen = new Set<string>();
  const candidates = [...vectorResults, ...textResults].filter((m) => {
    // Playbooks surface via their own index/ambient paths below —
    // excluded here so the two budgets never crowd each other.
    if (m.type === "playbook") return false;
    if (seen.has(m.id)) return false;
    seen.add(m.id);
    return true;
  });
  if (candidates.length === 0) return null;

  // Text-score normalization diverges from the server's absolute `/10`:
  // SurrealDB's search::score sits in a known 0–10ish band, but FTS5 bm25
  // ranks are fractional and corpus-dependent — an absolute divisor sank
  // every text-only hit below SCORE_FLOOR. Normalize per result set so the
  // best text match always scores 1.0 before the 0.3 weight.
  const maxTextScore = textResults.reduce(
    (max, r) => Math.max(max, r.score ?? 0),
    0,
  );

  const scored = candidates.map((m) => {
    const vectorScore =
      m.distance !== undefined ? 1 - Math.min(m.distance, 1) : 0;
    const textScore = maxTextScore > 0 ? (m.score ?? 0) / maxTextScore : 0;
    const combinedScore = Math.max(
      vectorScore * VECTOR_WEIGHT,
      textScore * TEXT_WEIGHT,
    );
    const projectBonus =
      opts.projectId && m.project_id === opts.projectId
        ? PROJECT_MATCH_BONUS
        : 0;
    const finalScore = scoreRetrievalCandidate({
      combinedScore,
      freshness: computeFreshness(m.last_accessed),
      confidence: m.confidence ?? 1,
      projectBonus,
    });
    return { id: m.id, content: m.content, score: finalScore };
  });

  const topMemories = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter((m) => m.score > SCORE_FLOOR);
  if (topMemories.length === 0) return null;

  const topIds = topMemories.map((m) => m.id);
  const related = includeRelated
    ? replica.getRelatedMemories(topIds, RELATED_LIMIT)
    : [];

  replica.touchMemories([...topIds, ...related.map((m) => m.id)]);

  return [
    ...topMemories.map((m) => m.content),
    ...related.map((m) => `[related] ${m.content}`),
  ];
};

// ── Playbooks: index + ambient (port of goldfish/playbook.ts) ──

type PlaybookEntry = ReplicaMemory & { readonly distance?: number };

const isStructured = (p: ReplicaMemory) => Boolean(p.name && p.trigger);

/** In-scope = global or bound to the active project; project-scoped first. */
const scopePlaybooks = (playbooks: ReplicaMemory[], projectId?: string) =>
  playbooks
    .filter(
      (p) =>
        !p.project_id ||
        (projectId !== undefined && p.project_id === projectId),
    )
    .sort((a, b) => (a.project_id ? 0 : 1) - (b.project_id ? 0 : 1));

const formatPlaybookBlock = (
  indexEntries: ReplicaMemory[],
  ambientBodies: PlaybookEntry[],
) => {
  if (indexEntries.length === 0) return null;
  const sections: string[] = [];
  const lines = indexEntries
    .slice(0, INDEX_CAP)
    .map((p) => `- ${p.name} — ${p.trigger}`)
    .join("\n");
  sections.push(
    `Available playbooks (learned procedures; load full steps with project_playbook_load):\n${lines}`,
  );
  if (ambientBodies.length > 0) {
    const bodies = ambientBodies
      .map((p) => `### ${p.name}\n${p.trigger}\n\n${p.content}`)
      .join("\n\n");
    sections.push(`Relevant to the current task:\n\n${bodies}`);
  }
  return sections.join("\n\n");
};

/**
 * Playbook context: always-on index of in-scope structured playbooks, plus
 * ambient bodies whose trigger vector matches the query. The ambient leg
 * needs both a query embedding and stored trigger embeddings — absent
 * either (pre-MIM-85), the index still surfaces alone.
 */
export const buildPlaybookContext = async (
  replica: OrgReplica,
  query: string,
  opts: RetrieveOpts = {},
) => {
  const structured = replica.listPlaybooks().filter(isStructured);
  if (structured.length === 0) return null;

  const scoped = scopePlaybooks(structured, opts.projectId);
  if (scoped.length === 0) return null;

  const queryEmbedding = opts.embedQuery ? await opts.embedQuery(query) : null;
  const ambient: PlaybookEntry[] = queryEmbedding
    ? replica
        .searchByVector(queryEmbedding, INDEX_CAP)
        .filter(
          (m) =>
            m.type === "playbook" &&
            isStructured(m) &&
            m.distance <= AMBIENT_MAX_DISTANCE &&
            scoped.some((s) => s.id === m.id),
        )
        .slice(0, AMBIENT_TOP_K)
    : [];

  return formatPlaybookBlock(scoped, ambient);
};

// ── Block assembly (port of buildContextInjection + /retrieve flattening) ──

const formatMemoryList = (memories: string[]) =>
  memories.map((m) => `- ${m}`).join("\n");

const buildContextParts = (
  summaries: Array<{ content: string }>,
  memories: string | null,
  playbooks: string | null,
) => {
  const parts: string[] = [];
  if (summaries.length > 0) {
    const summaryText = summaries
      .map((s, i) => `[Summary ${i + 1}]\n${s.content}`)
      .join("\n\n");
    parts.push(`<summaries>\n${summaryText}\n</summaries>`);
  }
  if (memories) parts.push(`<memories>\n${memories}\n</memories>`);
  if (playbooks) parts.push(`<playbooks>\n${playbooks}\n</playbooks>`);
  return parts;
};

export type RetrievedContext = {
  readonly contextBlock: string;
  readonly memoryCount: number;
  readonly summaryCount: number;
};

/**
 * The local equivalent of POST /v1/context/retrieve: memories + summaries +
 * playbooks flattened into one <retrieved_context> block. Empty block means
 * "inject nothing", exactly like the route's empty contextBlock contract.
 */
export const retrieveLocalContext = async (
  replica: OrgReplica,
  query: string,
  opts: RetrieveOpts = {},
) => {
  const retrieveOpts: RetrieveOpts = {
    ...opts,
    topK: opts.topK ?? RETRIEVE_MEMORY_TOP_K,
    includeRelated: opts.includeRelated ?? false,
  };

  const [memoryList, playbooks] = await Promise.all([
    retrieveMemoryList(replica, query, retrieveOpts),
    buildPlaybookContext(replica, query, retrieveOpts),
  ]);
  const summaries = replica.getLastSummaries(
    opts.summaryCount ?? RETRIEVE_SUMMARY_COUNT,
  );

  const memories = memoryList ? formatMemoryList(memoryList) : null;
  const parts = buildContextParts(summaries, memories, playbooks);
  if (parts.length === 0) {
    return { contextBlock: "", memoryCount: 0, summaryCount: 0 };
  }

  return {
    contextBlock: `<retrieved_context>\n${parts.join("\n\n")}\n</retrieved_context>`,
    memoryCount: memoryList?.length ?? 0,
    summaryCount: summaries.length,
  };
};
