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
 * listUnembedded/setEmbedding), dedup/neighbor-linking are skipped, and
 * search runs FTS-only.
 *
 * Tool definitions live in org-memory-defs.ts (re-exported here).
 */

import type { EmbedQuery } from "../brain/retrieve";
import { memoryEmbedSource, type OrgReplica } from "../store/org-replica";

export { orgMemoryToolDefs, orgMemoryToolNames } from "./org-memory-defs";

const SEARCH_VECTOR_CANDIDATES = 30;
const SEARCH_TEXT_CANDIDATES = 20;
const NEIGHBOR_LIMIT = 5;
const NEIGHBOR_MAX_DISTANCE = 0.3;

const str = (v: unknown) =>
  typeof v === "string" && v.length > 0 ? v : undefined;
const num = (v: unknown) => (typeof v === "number" ? v : undefined);

const json = (value: unknown) => ({
  content: JSON.stringify(value),
  isError: false,
});

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
const storeTyped = async (
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
) => {
  switch (name) {
    case "project_memory_search": {
      const query = str(args.query) ?? "";
      const limit = num(args.limit) ?? 10;
      const embedding = embedQuery ? await embedQuery(query) : null;
      const vector = embedding
        ? replica.searchByVector(embedding, SEARCH_VECTOR_CANDIDATES)
        : [];
      const text = replica.searchByText(query, SEARCH_TEXT_CANDIDATES);
      const seen = new Set<string>();
      const results = [...vector, ...text]
        .filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        })
        .slice(0, limit)
        .map((m) => ({ id: m.id, content: m.content }));
      return json({
        results,
        message: results.length === 0 ? "No memories found" : null,
      });
    }

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
