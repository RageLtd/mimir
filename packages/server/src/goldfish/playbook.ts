/**
 * Playbook data + retrieval (skill-parity layer).
 *
 * Playbooks are type="playbook" memories carrying structured `name` and
 * `trigger` fields. Unlike facts, a playbook's stored embedding is computed
 * from its trigger ("use this when…"), so it matches a task description far
 * better than its procedure body would. That trigger drives two of the three
 * surfacing paths this module powers:
 *
 *   1. Index  — every in-scope playbook's name + trigger (no bodies), always
 *               injected. Discovery, constant and cheap.
 *   2. Ambient — bodies of playbooks whose trigger embedding matches the
 *               current task, on a budget separate from fact retrieval.
 *
 * The third path (deliberate `project_playbook_load`) lives in the tool layer.
 *
 * Playbooks are excluded from the shared fact top-K (see goldfish/memory.ts)
 * so the two budgets never crowd each other.
 */

import { getDb, queryFirst, queryOne } from "../db/surreal";
import { resolveProjectForQuery } from "../projects/resolve-for-query";
import { log } from "../util/logger";
import { embedOne } from "./clients";
import { type Memory, toRecordId } from "./store";

const PLAYBOOK_TYPE = "playbook";

/** Max playbooks listed in the always-injected index. Past this, the list is
 *  truncated (project-scoped first) — revisit if libraries grow large. */
const INDEX_CAP = 20;
/** Max playbook bodies injected ambiently per turn — kept small so a matched
 *  procedure doesn't dominate the context. */
const AMBIENT_TOP_K = 2;
/** Cosine-distance ceiling for an ambient trigger match. The HNSW index uses
 *  DIST COSINE (distance = 1 − similarity); facts dedup at 0.05 and relate at
 *  0.30, but trigger↔task is a looser semantic match, so this sits higher.
 *  Starting point — tune against live matches. */
const AMBIENT_MAX_DISTANCE = 0.45;

export interface PlaybookRow {
  id: string;
  name?: string;
  trigger?: string;
  content: string;
  /** Canonical project ULID; unset on global playbooks. */
  project_id?: string;
}

export interface PlaybookWithEmbedding extends PlaybookRow {
  embedding: number[];
}

/** A playbook is "structured" — eligible for the index and ambient match —
 *  only once it has both a name and a trigger. Legacy body-embedded playbooks
 *  without them sit out until re-authored. */
export function isStructured(p: PlaybookRow) {
  return Boolean(p.name && p.trigger);
}

function toRow(m: Memory) {
  if (!m.id) return null;
  const row: PlaybookRow = {
    id: String(m.id),
    name: m.name,
    trigger: m.trigger,
    content: m.content,
    project_id: m.project_id,
  };
  return row;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Cosine distance in [0, 2], matching SurrealDB's DIST COSINE (1 − sim).
 *  Returns 2 (maximally distant) for a zero/empty vector pair. */
export function cosineDistance(a: number[], b: number[]) {
  if (a.length === 0 || a.length !== b.length) return 2;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 2;
  return 1 - dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Keep only in-scope playbooks — global (no project) plus those bound to the
 * active project — and order project-scoped first so the index leads with the
 * most relevant. Out-of-scope (other-project) playbooks are dropped entirely.
 */
export function scopePlaybooks<T extends PlaybookRow>(
  playbooks: T[],
  projectId?: string,
) {
  const inScope = playbooks.filter(
    (p) =>
      !p.project_id || (projectId !== undefined && p.project_id === projectId),
  );
  return inScope.sort((a, b) => {
    const aProj = a.project_id ? 0 : 1;
    const bProj = b.project_id ? 0 : 1;
    return aProj - bProj;
  });
}

/**
 * Rank playbooks by how well their trigger embedding matches the query, keep
 * those within AMBIENT_MAX_DISTANCE, and return the closest topK. This is the
 * mechanical ambient loader — no model judgment.
 */
export function rankByTrigger(
  queryEmbedding: number[],
  playbooks: PlaybookWithEmbedding[],
  opts: { topK?: number; maxDistance?: number } = {},
) {
  const topK = opts.topK ?? AMBIENT_TOP_K;
  const maxDistance = opts.maxDistance ?? AMBIENT_MAX_DISTANCE;
  return playbooks
    .map((p) => ({
      ...p,
      distance: cosineDistance(queryEmbedding, p.embedding),
    }))
    .filter((p) => p.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, topK);
}

/**
 * Format the playbook context block: an always-present index of names +
 * triggers, plus the bodies of any ambiently-matched playbooks. Returns null
 * when there are no structured playbooks to show.
 *
 * A matched playbook appears in both sections by design — the index names it,
 * the ambient section carries its body. Harmless reinforcement, not dedup.
 */
export function formatPlaybookBlock(
  indexEntries: PlaybookRow[],
  ambientBodies: PlaybookRow[],
) {
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
}

// ---------------------------------------------------------------------------
// DB access
// ---------------------------------------------------------------------------

/** Fetch every playbook row. Embeddings are pulled only when needed for the
 *  ambient match — the index path doesn't touch them. */
async function fetchPlaybooks(withEmbeddings: boolean) {
  const cols = withEmbeddings
    ? "id, name, trigger, content, project_id, embedding"
    : "id, name, trigger, content, project_id";
  const rows = await queryOne<Memory>(
    `SELECT ${cols} FROM memory WHERE type = $type`,
    { type: PLAYBOOK_TYPE },
  );
  return rows;
}

/** All structured playbooks for the project_playbook_list management tool.
 *  With a project identifier, scopes to global + that project; without one,
 *  returns every structured playbook so management isn't blind to other
 *  scopes. (The always-injected index uses buildPlaybookContext, not this.) */
export async function listPlaybooks(projectIdentifier?: string) {
  const rows = await fetchPlaybooks(false);
  const structured = rows.flatMap((m) => {
    const row = toRow(m);
    return row && isStructured(row) ? [row] : [];
  });
  if (!projectIdentifier) return structured;
  const projectId =
    (await resolveProjectForQuery(projectIdentifier)).project ||
    projectIdentifier;
  return scopePlaybooks(structured, projectId);
}

/** Resolve a single playbook by id or name. Name lookup returns the newest
 *  match when names collide (names aren't enforced unique). */
export async function getPlaybook(selector: { id?: string; name?: string }) {
  if (selector.id) {
    // Direct record fetch (the codebase's proven pattern for id lookups),
    // then guard the type in TS so non-playbook ids resolve to null.
    const row = await queryFirst<Memory>(
      `SELECT id, name, trigger, content, project_id, type FROM $id`,
      { id: toRecordId(selector.id) },
    );
    return row && row.type === PLAYBOOK_TYPE ? toRow(row) : null;
  }
  if (selector.name) {
    const rows = await queryOne<Memory>(
      `SELECT id, name, trigger, content, project_id FROM memory
       WHERE type = $type AND name = $name
       ORDER BY created_at DESC LIMIT 1`,
      { type: PLAYBOOK_TYPE, name: selector.name },
    );
    const first = rows[0];
    return first ? toRow(first) : null;
  }
  return null;
}

/**
 * Update an existing playbook's name/trigger/content. Re-embeds from the new
 * name+trigger whenever either changes (the trigger is the embedding key), so
 * ambient matching tracks edits. Returns the updated row or null if not found.
 */
export async function updatePlaybook(
  id: string,
  patch: { name?: string; trigger?: string; content?: string },
) {
  const existing = await getPlaybook({ id });
  if (!existing) return null;

  const name = patch.name ?? existing.name;
  const trigger = patch.trigger ?? existing.trigger;
  const content = patch.content ?? existing.content;

  const triggerChanged =
    patch.name !== undefined || patch.trigger !== undefined;

  const db = await getDb();
  const rid = toRecordId(id);

  if (triggerChanged) {
    const embedding = await embedOne(`${name ?? ""}\n${trigger ?? ""}`.trim());
    if (!embedding) {
      log.error({ id }, "failed to re-embed playbook trigger on update");
      return null;
    }
    await db.query(
      `UPDATE $id SET name = $name, trigger = $trigger, content = $content,
        embedding = $embedding, last_accessed = time::now()`,
      { id: rid, name, trigger, content, embedding },
    );
  } else {
    await db.query(
      `UPDATE $id SET content = $content, last_accessed = time::now()`,
      { id: rid, content },
    );
  }

  log.info({ id, triggerChanged }, "updated playbook");
  return { id, name, trigger, content, project_id: existing.project_id };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Build the playbook context block for a turn: the always-on index plus any
 * ambiently trigger-matched bodies. Returns null when nothing is in scope.
 *
 * `projectIdentifier` is resolved to the canonical project id the same way
 * stored playbooks are, so scoping compares like with like regardless of
 * whether the caller passed a UUID, path, or git remote.
 */
export async function buildPlaybookContext(
  query: string,
  opts: { projectIdentifier?: string } = {},
) {
  const start = Date.now();

  const rows = await fetchPlaybooks(true);
  const all = rows.flatMap((m) => {
    const row = toRow(m);
    if (!row || !isStructured(row)) return [];
    return [{ ...row, embedding: m.embedding ?? [] }];
  });
  if (all.length === 0) return null;

  const projectId = opts.projectIdentifier
    ? (await resolveProjectForQuery(opts.projectIdentifier)).project ||
      opts.projectIdentifier
    : undefined;

  const scoped = scopePlaybooks(all, projectId);
  if (scoped.length === 0) return null;

  const queryEmbedding = await embedOne(query, "query");
  const ambient = queryEmbedding ? rankByTrigger(queryEmbedding, scoped) : [];

  const block = formatPlaybookBlock(scoped, ambient);

  log.info(
    {
      total: all.length,
      inScope: scoped.length,
      ambientMatched: ambient.length,
      elapsed: `${Date.now() - start}ms`,
    },
    "playbook context built",
  );

  return block;
}
