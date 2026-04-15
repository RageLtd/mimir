/**
 * Session lifecycle management.
 *
 * Tracks per-conversation session state and provides the session_start
 * lifecycle hook that auto-resolves the project, checks Cartographer
 * index status, and loads project rules.
 *
 * Results are stored in an in-memory SessionStore keyed by fingerprint.
 * prepareAgent() reads from the store after emitting the lifecycle event,
 * which guarantees the store is populated (emitLifecycle awaits all hooks).
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { getDb } from "../db/surreal";
import { log } from "../util/logger";
import type { HookRegistry } from "./registry";

// ---------------------------------------------------------------------------
// SessionContext
// ---------------------------------------------------------------------------

export interface SessionContext {
  /** Resolved project root path (null if unresolvable) */
  project: string | null;
  /** Content of project rules files (CLAUDE.md, AGENTS.md, .claude/rules/) */
  rules: string | null;
  /** Human-readable Cartographer index status */
  indexStatus: string | null;
  /** Timestamp when this context was resolved */
  resolvedAt: number;
}

// ---------------------------------------------------------------------------
// SessionStore
// ---------------------------------------------------------------------------

export interface SessionStore {
  set(fingerprint: string, ctx: SessionContext): void;
  get(fingerprint: string): SessionContext | null;
  has(fingerprint: string): boolean;
  delete(fingerprint: string): void;
  prune(maxAgeMs: number): number;
  readonly size: number;
}

export function createSessionStore(): SessionStore {
  const sessions = new Map<string, SessionContext>();

  return {
    set(fingerprint, ctx) {
      sessions.set(fingerprint, ctx);
    },

    get(fingerprint) {
      return sessions.get(fingerprint) ?? null;
    },

    has(fingerprint) {
      return sessions.has(fingerprint);
    },

    delete(fingerprint) {
      sessions.delete(fingerprint);
    },

    prune(maxAgeMs) {
      const cutoff = Date.now() - maxAgeMs;
      let pruned = 0;
      for (const [key, ctx] of sessions) {
        if (ctx.resolvedAt < cutoff) {
          sessions.delete(key);
          pruned++;
        }
      }
      return pruned;
    },

    get size() {
      return sessions.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let store: SessionStore | null = null;

export function getSessionStore() {
  if (!store) store = createSessionStore();
  return store;
}

/** Replace the global instance (for testing). */
export function setSessionStore(s: SessionStore) {
  store = s;
}

// ---------------------------------------------------------------------------
// Project resolution
// ---------------------------------------------------------------------------

/**
 * Auto-resolve the active project from Cartographer's index.
 *
 * - If exactly one project is indexed, returns it.
 * - If zero or multiple projects, returns null (caller should use the
 *   client-provided project path from Zed's system message).
 */
async function autoResolveProject() {
  try {
    const db = await getDb();
    const [result] = await db.query<
      [Array<{ project: string; count: number }>]
    >(`SELECT project, count() AS count FROM cart_file GROUP BY project`);

    const projects = result ?? [];
    if (projects.length === 1 && projects[0]?.project) {
      return projects[0].project;
    }
    return null;
  } catch (err) {
    log.warn({ err }, "failed to auto-resolve project from Cartographer");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Index status check
// ---------------------------------------------------------------------------

async function checkIndexStatus(project: string) {
  try {
    const db = await getDb();
    const [result] = await db.query<[Array<{ count: number }>]>(
      `SELECT count() AS count FROM cart_file WHERE project = $project GROUP ALL`,
      { project },
    );
    const count = result?.[0]?.count ?? 0;
    if (count === 0) {
      return `No files indexed for ${project}. Structural queries (cartographer_search, cartographer_query) will return empty results until Cartographer indexes this project.`;
    }
    return `${count} files indexed for ${project}.`;
  } catch (err) {
    log.warn({ err, project }, "failed to check Cartographer index status");
    return "Cartographer index status unavailable.";
  }
}

// ---------------------------------------------------------------------------
// Rules loading
// ---------------------------------------------------------------------------

/** Well-known rules file names at project root */
const ROOT_RULES_FILES = ["CLAUDE.md", "AGENTS.md"];

/** Well-known rules directories */
const RULES_DIRS = [".claude/rules"];

/**
 * Load project rules from well-known locations.
 *
 * Reads CLAUDE.md, AGENTS.md, and .claude/rules/*.md from the project
 * root. Returns null if no rules files are found or if the project path
 * is not accessible from the server.
 */
async function loadProjectRules(project: string) {
  const parts: string[] = [];

  // Root-level rules files
  for (const name of ROOT_RULES_FILES) {
    const filePath = join(project, name);
    try {
      const file = Bun.file(filePath);
      if (await file.exists()) {
        const content = await file.text();
        if (content.trim()) {
          parts.push(`--- ${name} ---\n${content.trim()}`);
        }
      }
    } catch (err) {
      log.debug(
        { filePath, err: err instanceof Error ? err.message : String(err) },
        "rules file not accessible",
      );
    }
  }

  // Rules directories
  for (const dir of RULES_DIRS) {
    const dirPath = join(project, dir);
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      const mdFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .sort((a, b) => a.name.localeCompare(b.name));

      for (const entry of mdFiles) {
        const filePath = join(dirPath, entry.name);
        try {
          const content = await Bun.file(filePath).text();
          if (content.trim()) {
            parts.push(`--- ${dir}/${entry.name} ---\n${content.trim()}`);
          }
        } catch (err) {
          log.debug(
            { filePath, err: err instanceof Error ? err.message : String(err) },
            "individual rules file read failed",
          );
        }
      }
    } catch (err) {
      log.debug(
        { dirPath, err: err instanceof Error ? err.message : String(err) },
        "rules directory not accessible",
      );
    }
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

// ---------------------------------------------------------------------------
// Session context resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the full session context for a conversation.
 *
 * 1. Resolve the project (use provided path, or auto-detect from Cartographer)
 * 2. Check Cartographer index status
 * 3. Load project rules files
 */
export async function resolveSessionContext(
  clientProject: string | null,
  fingerprint: string | null,
) {
  const start = Date.now();

  // Resolve project: prefer client-provided path, fall back to auto-detect
  const project = clientProject ?? (await autoResolveProject());

  // Check index status
  const indexStatus = project ? await checkIndexStatus(project) : null;

  // Load rules
  const rules = project ? await loadProjectRules(project) : null;

  const elapsed = Date.now() - start;
  log.info(
    {
      project,
      hasRules: !!rules,
      rulesChars: rules?.length ?? 0,
      indexStatus,
      fingerprint,
      elapsed: `${elapsed}ms`,
    },
    "session context resolved",
  );

  return {
    project,
    rules,
    indexStatus,
    resolvedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Lifecycle hook registration
// ---------------------------------------------------------------------------

/**
 * Register the session_start lifecycle hook.
 *
 * On first request for a fingerprint:
 * - Resolves the project from Cartographer
 * - Checks index status
 * - Loads project rules
 * - Stores the result in the SessionStore
 */
export function registerSessionHooks(registry: HookRegistry) {
  const sessionStore = getSessionStore();

  registry.onLifecycle(async (event) => {
    if (event.type !== "session_start") return;

    const fp = event.fingerprint;
    if (!fp) return;

    // Skip if already resolved for this session
    if (sessionStore.has(fp)) return;

    const ctx = await resolveSessionContext(event.project, fp);
    sessionStore.set(fp, ctx);
  });

  registry.onLifecycle(async (event) => {
    if (event.type !== "compaction_triggered") return;

    log.info(
      {
        fingerprint: event.fingerprint,
        tokenCount: event.tokenCount,
      },
      "lifecycle: compaction triggered",
    );

    // Future: could trigger memory extraction, summarization, etc.
    // For now, just log — compaction itself is handled in context.ts
  });
}
