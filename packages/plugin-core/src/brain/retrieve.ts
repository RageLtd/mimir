/**
 * Local retrieval brain — what a prompt pulls out of the org replica:
 * facts and summaries near enough to the prompt, plus the playbook index,
 * flattened into one `<retrieved_context>` block.
 *
 * A row is admitted on the cosine distance between the prompt and the row,
 * nothing else (MIM-147). The cutoffs are absolute, so a prompt nothing
 * matches injects nothing, however large the replica grows. A row from
 * another project is admitted on the same terms as an unscoped one — a
 * similar bug fixed elsewhere is worth recalling — and the active
 * project's rows get a wider cutoff, which also ranks them ahead.
 *
 * Without a query vector there is no retrieval. Full-text search is not a
 * substitute: it matches any shared word, which is how unrelated rows used
 * to arrive on every prompt. Callers report `embedderUnavailable`.
 *
 * Retrieval is passive: it never touches a row's access time or count.
 */

import type { OrgReplica, ReplicaMemory } from "../store/org-replica";

/** Query embedder seam. Undefined or a null result means no vector. */
export type EmbedQuery = (text: string) => Promise<number[] | null>;

// ── Distance gate. Measured on real prompts against a 1,700-row replica
//    with Qwen3-Embedding-0.6B: unrelated pairs sit at a median of 0.63
//    and almost never under 0.45; a prompt's nearest row sits at a median
//    of 0.35. Re-measure if EMBEDDER_MODEL changes. ──
export const CROSS_PROJECT_MAX_DISTANCE = 0.35;
export const SAME_PROJECT_MAX_DISTANCE = 0.4;
/** Nearest rows fetched before the gate; far more than it ever admits. */
const VECTOR_CANDIDATES = 200;

// ── Playbook constants: verbatim from goldfish/playbook.ts ──
const INDEX_CAP = 20;
const AMBIENT_TOP_K = 2;
const AMBIENT_MAX_DISTANCE = 0.45;

// ── Per-prompt budgets; boot passes larger ones. ──
const DEFAULT_MEMORY_TOP_K = 10;
const RETRIEVE_MEMORY_TOP_K = 3;
const RETRIEVE_SUMMARY_COUNT = 1;
const RETRIEVE_MAX_CHARS = 4000;

const UNNAMED_PROJECT = "another project";

export type RetrieveOpts = {
  /** Most facts returned. */
  readonly topK?: number;
  /** Canonical project id — widens the gate for that project's rows and
   *  scopes playbooks. */
  readonly projectId?: string;
  /** Most summaries injected. */
  readonly summaryCount?: number;
  readonly embedQuery?: EmbedQuery;
  /** Character budget for injected fact and summary text. */
  readonly maxChars?: number;
  /** Row ids already in the session's context; never returned again. */
  readonly exclude?: ReadonlySet<string>;
  /** Project id → display name, for labelling rows from other projects. */
  readonly projectNames?: Readonly<Record<string, string>>;
};

type Admitted = {
  readonly id: string;
  readonly content: string;
  readonly isSummary: boolean;
  readonly projectId: string | null;
  readonly createdAt: string;
  readonly score: number;
};

/**
 * Rows under the distance gate, best first. Score is the room a row has
 * under its own cutoff, scaled by confidence, so the active project's
 * wider cutoff ranks its rows ahead of equally near ones.
 */
const admitRows = async (
  replica: OrgReplica,
  query: string,
  opts: RetrieveOpts,
) => {
  const none: Admitted[] = [];
  if (!query.trim()) return { rows: none, embedderUnavailable: false };
  const embedding = opts.embedQuery ? await opts.embedQuery(query) : null;
  if (!embedding) return { rows: none, embedderUnavailable: true };

  const rows = replica
    .searchByVector(embedding, VECTOR_CANDIDATES)
    .flatMap((m) => {
      // Playbooks surface through their own index and ambient paths.
      if (m.type === "playbook" || opts.exclude?.has(m.id)) return none;
      const sameProject =
        opts.projectId !== undefined && m.project_id === opts.projectId;
      const cutoff = sameProject
        ? SAME_PROJECT_MAX_DISTANCE
        : CROSS_PROJECT_MAX_DISTANCE;
      const room = cutoff - m.distance;
      if (room <= 0) return none;
      return [
        {
          id: m.id,
          content: m.content,
          isSummary: m.type === "summary",
          projectId: m.project_id,
          createdAt: m.created_at,
          score: room * (m.confidence ?? 1),
        },
      ];
    })
    .sort((a, b) => b.score - a.score);
  return { rows, embedderUnavailable: false };
};

type Labelled = {
  readonly content: string;
  readonly projectId: string | null;
  readonly createdAt: string;
};

/** A row's date, and its project when that is not the active one. */
const provenance = (row: Labelled, opts: RetrieveOpts) => {
  const date = row.createdAt.slice(0, 10);
  if (
    row.projectId === null ||
    opts.projectId === undefined ||
    row.projectId === opts.projectId
  ) {
    return date;
  }
  return `${date}, from ${opts.projectNames?.[row.projectId] ?? UNNAMED_PROJECT}`;
};

const factLine = (row: Labelled, opts: RetrieveOpts) =>
  `[${provenance(row, opts)}] ${row.content}`;

/**
 * The facts a query admits, as labelled strings, or null. Used directly
 * for per-file memories; `retrieveLocalContext` is the per-prompt path.
 */
export const retrieveMemoryList = async (
  replica: OrgReplica,
  query: string,
  opts: RetrieveOpts = {},
) => {
  const { rows } = await admitRows(replica, query, opts);
  const facts = rows
    .filter((row) => !row.isSummary)
    .slice(0, opts.topK ?? DEFAULT_MEMORY_TOP_K);
  return facts.length > 0 ? facts.map((fact) => factLine(fact, opts)) : null;
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
 * either, the index still surfaces alone.
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

// ── Block assembly ──

export const formatMemoryList = (memories: string[]) =>
  memories.map((m) => `- ${m}`).join("\n");

const buildContextParts = (
  summaries: readonly string[],
  memories: readonly string[],
  playbooks: string | null,
) => {
  const parts: string[] = [];
  if (summaries.length > 0) {
    parts.push(`<summaries>\n${summaries.join("\n\n")}\n</summaries>`);
  }
  if (memories.length > 0) {
    parts.push(`<memories>\n${formatMemoryList([...memories])}\n</memories>`);
  }
  if (playbooks) parts.push(`<playbooks>\n${playbooks}\n</playbooks>`);
  return parts;
};

export type RetrievedContext = {
  readonly contextBlock: string;
  readonly memoryCount: number;
  readonly summaryCount: number;
  /** Fact and summary ids in the block — the caller's skip list grows by
   *  these so a row is sent once per context window. */
  readonly injectedIds: readonly string[];
  /** True when no query vector could be had, so nothing was retrieved. */
  readonly embedderUnavailable: boolean;
};

/**
 * One prompt's `<retrieved_context>` block: the best-matching summary, the
 * facts under the gate and the playbook index, inside a character budget.
 * An empty block means inject nothing.
 */
export const retrieveLocalContext = async (
  replica: OrgReplica,
  query: string,
  opts: RetrieveOpts = {},
) => {
  const [admitted, playbooks] = await Promise.all([
    admitRows(replica, query, opts),
    buildPlaybookContext(replica, query, opts),
  ]);

  const maxFacts = opts.topK ?? RETRIEVE_MEMORY_TOP_K;
  const maxSummaries = opts.summaryCount ?? RETRIEVE_SUMMARY_COUNT;
  let remaining = opts.maxChars ?? RETRIEVE_MAX_CHARS;
  const facts: Admitted[] = [];
  const summaries: Admitted[] = [];
  // Best first across both kinds; a row that does not fit is passed over
  // so a smaller one further down still can.
  for (const row of admitted.rows) {
    const kept = row.isSummary ? summaries : facts;
    const cap = row.isSummary ? maxSummaries : maxFacts;
    if (kept.length >= cap || row.content.length > remaining) continue;
    kept.push(row);
    remaining -= row.content.length;
  }

  const parts = buildContextParts(
    summaries.map(
      (row, i) =>
        `[Summary ${i + 1}, ${provenance(row, opts)}]\n${row.content}`,
    ),
    facts.map((row) => factLine(row, opts)),
    playbooks,
  );

  return {
    contextBlock:
      parts.length > 0
        ? `<retrieved_context>\n${parts.join("\n\n")}\n</retrieved_context>`
        : "",
    memoryCount: facts.length,
    summaryCount: summaries.length,
    injectedIds: [...summaries, ...facts].map((row) => row.id),
    embedderUnavailable: admitted.embedderUnavailable,
  };
};
