/**
 * Executor for the local project-memory + playbook tools (MIM-84).
 *
 * Same result shapes as the server executors (agent/server-tools/memory.ts
 * + playbook.ts) so the model sees identical payloads either way. The
 * difference is where they read and write: the org-replica SQLite file,
 * not SurrealDB. Single-user paradigm: writes are local-only, no server
 * write-through (MIM-88's encrypted sync replaces that whole story).
 *
 * Embedding seam: `embedQuery` optional, as in brain/retrieve.ts. With no
 * embedder (pre-MIM-85) stores land unembedded (backfilled later via
 * listUnembedded/setEmbedding) and dedup/neighbor-linking are skipped.
 *
 * Search has two paths:
 *  - With a query vector, a row is admitted on the same distance gate as
 *    per-prompt retrieval (brain/retrieve.ts): the active project's rows
 *    get the wider ceiling and rank ahead, near rows from other projects
 *    are still returned. A row containing every query term is admitted
 *    too, ranked as though it sat at TEXT_HIT_EQUIVALENT_DISTANCE; a row
 *    sharing only some words is left to the vector leg.
 *  - With no query vector (no embedder, or it returned null), search is
 *    full-text on any shared word in BM25 order, ungated — there is no
 *    distance to gate on, and a tool call the model asked for should still
 *    find what the words match.
 * Either way playbooks are excluded (they have their own tools) and a
 * row's distance is null when it was not admitted by vector.
 *
 * Tool definitions live in org-memory-defs.ts (re-exported here).
 */

import {
  CROSS_PROJECT_MAX_DISTANCE,
  type DistanceCeilings,
  type EmbedQuery,
  gatedScore,
  SAME_PROJECT_MAX_DISTANCE,
} from "../brain/retrieve";
import {
  memoryEmbedSource,
  type OrgReplica,
  type ReplicaMemory,
} from "../store/org-replica";

export { orgMemoryToolDefs, orgMemoryToolNames } from "./org-memory-defs";

/** Turns the tool's `project` argument (or its absence) into the active
 *  project id; undefined means no active project. */
export type ResolveProjectId = (
  project: string | undefined,
) => Promise<string | undefined>;

// The search ceilings alias retrieve's: the same measured gate applies
// today, but named separately so an explicit search can be tuned looser
// or tighter than per-prompt injection without touching the other.
export const SEARCH_CROSS_PROJECT_MAX_DISTANCE = CROSS_PROJECT_MAX_DISTANCE;
export const SEARCH_SAME_PROJECT_MAX_DISTANCE = SAME_PROJECT_MAX_DISTANCE;
/** Where a row matching every query term ranks when the vector gate did
 *  not admit it: ahead of marginal vector hits, behind close ones. */
export const TEXT_HIT_EQUIVALENT_DISTANCE = 0.25;

const SEARCH_CEILINGS: DistanceCeilings = {
  crossProject: SEARCH_CROSS_PROJECT_MAX_DISTANCE,
  sameProject: SEARCH_SAME_PROJECT_MAX_DISTANCE,
};
/** Nearest rows fetched before the gate; far more than it ever admits. */
const SEARCH_VECTOR_CANDIDATES = 200;
const SEARCH_TEXT_CANDIDATES = 50;
const DEFAULT_SEARCH_LIMIT = 10;
const NEIGHBOR_LIMIT = 5;
const NEIGHBOR_MAX_DISTANCE = 0.3;

const str = (v: unknown) =>
  typeof v === "string" && v.length > 0 ? v : undefined;
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

const json = (value: unknown) => ({
  content: JSON.stringify(value),
  isError: false,
});

/** Lower-cased word tokens, split as FTS5's default unicode61 tokenizer
 *  splits them. */
const termsOf = (text: string) =>
  new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** Every word of the query counts, common ones ("the", "how") included —
 *  deliberately: there is no stopword list to drift from FTS, and a
 *  full-sentence query is what the vector leg is for. */
const hasEveryTerm = (content: string, terms: ReadonlySet<string>) => {
  const words = termsOf(content);
  return [...terms].every((term) => words.has(term));
};

type SearchHit = {
  readonly id: string;
  readonly content: string;
  readonly distance: number | null;
  readonly project_id: string | null;
  readonly created_at: string;
  readonly score: number;
};

const toHit = (m: ReplicaMemory, distance: number | null, score: number) => ({
  id: m.id,
  content: m.content,
  distance,
  project_id: m.project_id,
  created_at: m.created_at,
  score,
});

const toResult = ({ score: _score, ...row }: SearchHit) => row;

/** No query vector: any shared word, BM25 order, playbooks excluded. */
const searchFullText = (replica: OrgReplica, query: string, limit: number) =>
  termsOf(query).size === 0
    ? []
    : replica
        .searchByText(query, SEARCH_TEXT_CANDIDATES)
        .filter((m) => m.type !== "playbook")
        .slice(0, limit)
        .map((m) => toResult(toHit(m, null, m.score)));

/**
 * Gated, project-aware search: vector hits under their ceiling plus rows
 * containing every query term, best score first. A row admitted both ways
 * keeps its distance and the better of its two scores.
 */
const searchGated = (
  replica: OrgReplica,
  query: string,
  embedding: number[],
  projectId: string | undefined,
  limit: number,
) => {
  const scoreAt = (m: ReplicaMemory, distance: number) =>
    gatedScore(
      {
        distance,
        confidence: m.confidence,
        sameProject: projectId !== undefined && m.project_id === projectId,
      },
      SEARCH_CEILINGS,
    );

  const vectorHits: SearchHit[] = replica
    .searchByVector(embedding, SEARCH_VECTOR_CANDIDATES)
    .flatMap((m) => {
      if (m.type === "playbook") return [];
      const score = scoreAt(m, m.distance);
      return score === null ? [] : [toHit(m, m.distance, score)];
    });

  const terms = termsOf(query);
  const textHits: SearchHit[] = (
    terms.size > 0 ? replica.searchByText(query, SEARCH_TEXT_CANDIDATES) : []
  ).flatMap((m) => {
    if (m.type === "playbook" || !hasEveryTerm(m.content, terms)) return [];
    const score = scoreAt(m, TEXT_HIT_EQUIVALENT_DISTANCE);
    return score === null ? [] : [toHit(m, null, score)];
  });

  const merged = new Map(vectorHits.map((hit) => [hit.id, hit]));
  for (const hit of textHits) {
    const existing = merged.get(hit.id);
    merged.set(
      hit.id,
      existing
        ? { ...existing, score: Math.max(existing.score, hit.score) }
        : hit,
    );
  }

  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(toResult);
};

const searchMemories = async (
  replica: OrgReplica,
  args: Record<string, unknown>,
  embedQuery: EmbedQuery | undefined,
  resolveProjectId: ResolveProjectId | undefined,
) => {
  const query = str(args.query) ?? "";
  const limit = num(args.limit) ?? DEFAULT_SEARCH_LIMIT;
  const projectId = resolveProjectId
    ? await resolveProjectId(str(args.project))
    : undefined;
  const embedding = embedQuery ? await embedQuery(query) : null;
  const results = embedding
    ? searchGated(replica, query, embedding, projectId, limit)
    : searchFullText(replica, query, limit);
  return json({
    results,
    message: results.length === 0 ? "No memories found" : null,
  });
};

const findPlaybook = (
  replica: OrgReplica,
  selector: { id?: string; name?: string },
) => {
  if (selector.id) {
    const row = replica.getMemory(selector.id);
    return row && row.type === "playbook" ? row : null;
  }
  if (selector.name) {
    return (
      replica
        .listPlaybooks()
        .filter((p) => p.name === selector.name)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
    );
  }
  return null;
};

const linkNeighbors = (
  replica: OrgReplica,
  id: string,
  embedding: number[],
) => {
  let linked = 0;
  for (const neighbor of replica.findNeighbors(
    embedding,
    id,
    NEIGHBOR_LIMIT,
    NEIGHBOR_MAX_DISTANCE,
  )) {
    replica.createRelation(id, neighbor.id, Math.max(0, 1 - neighbor.distance));
    linked++;
  }
  return linked;
};

/** Embed → dedup → store → link, mirroring the server's storeTypedMemory.
 *  Without an embedder every embedding-dependent step degrades gracefully. */
export const storeTyped = async (
  replica: OrgReplica,
  embedQuery: EmbedQuery | undefined,
  args: {
    content: string;
    project?: string;
    type: "fact" | "playbook";
    name?: string;
    trigger?: string;
  },
) => {
  const embedSource = memoryEmbedSource(args);
  const embedding = embedQuery ? await embedQuery(embedSource) : null;

  if (embedding) {
    const duplicate = replica.findDuplicate(embedding);
    if (duplicate) {
      return {
        stored: false,
        duplicate: duplicate.content,
        message: "Similar memory exists",
      };
    }
  }

  const id = replica.storeMemory({
    content: args.content,
    project_id: args.project,
    type: args.type,
    name: args.name,
    trigger: args.trigger,
    embedding,
  });

  const neighbors = embedding ? linkNeighbors(replica, id, embedding) : 0;
  return { stored: true, id, neighbors_linked: neighbors, error: null };
};

/**
 * Execute an org-memory tool against the replica. Result shapes mirror the
 * server executors so the model sees identical payloads either way.
 */
export const executeOrgMemoryTool = async (
  replica: OrgReplica,
  name: string,
  args: Record<string, unknown>,
  embedQuery?: EmbedQuery,
  /** Omitted, there is no active project and every row is held to the
   *  cross-project ceiling. */
  resolveProjectId?: ResolveProjectId,
) => {
  switch (name) {
    case "project_memory_search":
      return searchMemories(replica, args, embedQuery, resolveProjectId);

    case "project_memory_store": {
      const content = str(args.content);
      if (!content) return json({ stored: false, error: "content required" });
      return json(
        await storeTyped(replica, embedQuery, {
          content,
          project: str(args.project),
          type: "fact",
        }),
      );
    }

    case "project_memory_update": {
      const id = str(args.id);
      const content = str(args.content);
      if (!id || !content) {
        return json({ updated: false, error: "id and content required" });
      }
      const embedding = embedQuery ? await embedQuery(content) : null;
      const updated = replica.updateMemory(id, content, embedding);
      if (!updated) {
        return json({ updated: false, error: `Memory not found: ${id}` });
      }
      const neighbors = embedding ? linkNeighbors(replica, id, embedding) : 0;
      return json({
        updated: true,
        id,
        neighbors_linked: neighbors,
        error: null,
      });
    }

    case "project_memory_list": {
      const memories = replica.listMemories(num(args.limit) ?? 20);
      return json({
        memories: memories.map((m) => ({
          id: m.id,
          content: m.content,
          project_id: m.project_id,
          created_at: m.created_at,
          access_count: m.access_count,
        })),
        error: null,
      });
    }

    case "project_memory_delete": {
      const id = str(args.id);
      if (!id) return json({ deleted: false, error: "id required" });
      const deleted = replica.deleteMemory(id);
      return json({
        deleted,
        id,
        error: deleted ? null : `Memory not found: ${id}`,
      });
    }

    case "project_playbook_store": {
      const playbookName = str(args.name);
      const trigger = str(args.trigger);
      const content = str(args.content);
      if (!playbookName || !trigger || !content) {
        return json({
          stored: false,
          error: "name, trigger, and content are all required",
        });
      }
      return json(
        await storeTyped(replica, embedQuery, {
          content,
          project: str(args.project),
          type: "playbook",
          name: playbookName,
          trigger,
        }),
      );
    }

    case "project_playbook_list": {
      const playbooks = replica.listPlaybooks().map((p) => ({
        id: p.id,
        name: p.name,
        trigger: p.trigger,
        project_id: p.project_id,
      }));
      return json({ playbooks, error: null });
    }

    case "project_playbook_load": {
      const selector = { id: str(args.id), name: str(args.name) };
      if (!selector.id && !selector.name) {
        return json({ found: false, error: "Provide a playbook name or id" });
      }
      const playbook = findPlaybook(replica, selector);
      if (!playbook) {
        return json({
          found: false,
          error: `Playbook not found: ${selector.name ?? selector.id}`,
        });
      }
      return json({
        found: true,
        id: playbook.id,
        name: playbook.name,
        trigger: playbook.trigger,
        content: playbook.content,
        project_id: playbook.project_id,
        error: null,
      });
    }

    case "project_playbook_update": {
      const selector = { id: str(args.id), name: str(args.name) };
      if (!selector.id && !selector.name) {
        return json({
          updated: false,
          error: "Provide a playbook name or id to update",
        });
      }
      const newName = str(args.newName);
      const trigger = str(args.trigger);
      const content = str(args.content);
      if (!newName && !trigger && !content) {
        return json({
          updated: false,
          error: "Nothing to update — provide newName, trigger, or content",
        });
      }
      const target = findPlaybook(replica, selector);
      if (!target) {
        return json({
          updated: false,
          error: `Playbook not found: ${selector.name ?? selector.id}`,
        });
      }
      const mergedName = newName ?? target.name ?? undefined;
      const mergedTrigger = trigger ?? target.trigger ?? undefined;
      const mergedContent = content ?? target.content;
      // Rebuild via upsert (name/trigger aren't covered by updateMemory);
      // name/trigger changes re-embed when an embedder is present.
      const embedding =
        (newName || trigger) && embedQuery
          ? await embedQuery(
              `${mergedName ?? ""}\n${mergedTrigger ?? ""}`.trim(),
            )
          : null;
      replica.upsertMemory({
        id: target.id,
        org_id: target.org_id,
        content: mergedContent,
        project_id: target.project_id ?? undefined,
        type: "playbook",
        name: mergedName,
        trigger: mergedTrigger,
        confidence: target.confidence,
        access_count: target.access_count,
        created_at: target.created_at,
        last_accessed: target.last_accessed ?? undefined,
        embedding,
      });
      return json({
        updated: true,
        id: target.id,
        name: mergedName,
        error: null,
      });
    }

    case "project_playbook_delete": {
      const selector = { id: str(args.id), name: str(args.name) };
      if (!selector.id && !selector.name) {
        return json({
          deleted: false,
          error: "Provide a playbook name or id to delete",
        });
      }
      const target = findPlaybook(replica, selector);
      if (!target) {
        return json({
          deleted: false,
          error: `Playbook not found: ${selector.name ?? selector.id}`,
        });
      }
      const deleted = replica.deleteMemory(target.id);
      return json({
        deleted,
        id: target.id,
        name: target.name,
        error: deleted ? null : `Failed to delete: ${target.id}`,
      });
    }

    default:
      return { content: `Unknown tool: ${name}`, isError: true };
  }
};
