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
 * One exception to the gate: a session's first prompt gets the active
 * project's newest summary when no summary is near the prompt, so a new
 * session knows where the last one left off. While the last session's
 * summary is still being written (`summaryPending`), the summary is
 * reported deferred whatever the gate admitted: the newest stored summary
 * is an older session's, so the fallback stays out of the slot, a summary
 * near the prompt is still injected, and the caller asks again on the next
 * prompt.
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
  /** The session's first prompt: with no summary near the prompt, the
   *  active project's newest one is injected regardless of distance
   *  (still within `summaryCount`, so a cap of zero injects none). */
  readonly sessionStart?: boolean;
  /** With `sessionStart`: the last session's summary is still being
   *  written, so the newest stored one is not where it left off. The
   *  fallback is not filled and the summary is reported deferred
   *  (`summaryDeferred`), even when a near summary was injected. */
  readonly summaryPending?: boolean;
};

type Admitted = {
  readonly id: string;
  readonly content: string;
  readonly isSummary: boolean;
  readonly projectId: string | null;
  readonly createdAt: string;
  readonly score: number;
};

export type DistanceCeilings = {
  readonly crossProject: number;
  readonly sameProject: number;
};

const RETRIEVE_CEILINGS: DistanceCeilings = {
  crossProject: CROSS_PROJECT_MAX_DISTANCE,
  sameProject: SAME_PROJECT_MAX_DISTANCE,
};

/**
 * A row's gate score: the room it has under its own ceiling, scaled by
 * confidence (a missing confidence counts as full), or null when it is
 * past the ceiling. The active project's wider ceiling ranks its rows
 * ahead of equally near ones.
 */
export const gatedScore = (
  row: {
    readonly distance: number;
    readonly confidence: number | null | undefined;
    readonly sameProject: boolean;
  },
  ceilings: DistanceCeilings,
) => {
  const ceiling = row.sameProject
    ? ceilings.sameProject
    : ceilings.crossProject;
  const room = ceiling - row.distance;
  return room > 0 ? room * (row.confidence ?? 1) : null;
};

/** Rows under the distance gate, best first by `gatedScore`. */
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
      const score = gatedScore(
        {
          distance: m.distance,
          confidence: m.confidence,
          sameProject,
        },
        RETRIEVE_CEILINGS,
      );
      if (score === null) return none;
      return [
        {
          id: m.id,
          content: m.content,
          isSummary: m.type === "summary",
          projectId: m.project_id,
          createdAt: m.created_at,
          score,
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
  /** True on a session's first prompt while the last session's summary is
   *  still being written: the newest-summary fallback was withheld, and
   *  the caller should ask again — even when a near summary was injected.
   *  Never with a summary cap of zero. */
  readonly summaryDeferred: boolean;
};

/**
 * On a session's first prompt, the active project's newest summary not
 * already in context — where the last session left off. It needs no query
 * vector and no nearness, and it is not charged to the character budget.
 */
const newestProjectSummary = (replica: OrgReplica, opts: RetrieveOpts) => {
  if (!opts.sessionStart || opts.projectId === undefined) return null;
  const excluded = opts.exclude?.size ?? 0;
  const row = replica
    .getLastSummaries(excluded + 1, opts.projectId)
    .find((s) => !opts.exclude?.has(s.id));
  if (!row) return null;
  return {
    id: row.id,
    content: row.content,
    isSummary: true,
    projectId: opts.projectId,
    createdAt: row.created_at,
    score: 0,
  } satisfies Admitted;
};

/**
 * One prompt's `<retrieved_context>` block: the best-matching summary, the
 * facts under the gate and the playbook index, inside a character budget.
 * On a session's first prompt with no summary near enough, the active
 * project's newest summary takes the summary slot instead — unless the
 * summary cap is zero, or the last session's summary is still pending.
 * While it is pending (and the cap is not zero) the summary is reported
 * deferred, near summary injected or not. An empty block means inject
 * nothing.
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
  // A near summary is no stand-in for the one still being written, so the
  // wait goes on whatever the gate admitted.
  const summaryDeferred =
    maxSummaries > 0 &&
    opts.sessionStart === true &&
    opts.projectId !== undefined &&
    opts.summaryPending === true;
  if (summaries.length === 0 && maxSummaries > 0 && !summaryDeferred) {
    const newest = newestProjectSummary(replica, opts);
    if (newest) summaries.push(newest);
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
    summaryDeferred,
  };
};
