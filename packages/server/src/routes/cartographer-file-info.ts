/**
 * Cartographer File-Info Handler — extracted from cartographer.ts to keep
 * that file under the 500-line guardrail.
 *
 * Return per-file context used by the mimir-cc plugin's PreToolUse Read
 * hook to inject `<file_context>` blocks into the model's view. Returns
 * the symbols defined in the file, the file's imports, dependents (files
 * that import this one, capped), the content hash for plugin-side dedup,
 * and semantically related memories.
 *
 * Empty arrays / null / "" on miss — the plugin treats absence as
 * "skip injection," not as an error, so 404 would be the wrong shape.
 *
 * Storage keys exclusively on canonical project ULIDs (project_id).
 * The request may carry either `projectId` (preferred) or the legacy
 * `project` path — both are resolved to the canonical id at this
 * boundary via resolveProjectForQuery. Unresolvable identifiers fall
 * through to queries that match nothing, which returns the empty shape.
 */

import type { Context } from "hono";
import { rootScope } from "../db/scope";
import { getDb, queryFirst, queryOne } from "../db/surreal";
import { formatMemoryList, retrieveMemoryList } from "../goldfish/memory";
import { resolveProjectForQuery } from "../projects/resolve-for-query";
import { log } from "../util/logger";
import { attempt } from "../util/result";

// Cap on dependents returned by /file-info — the model gets a useful
// "this is a hot file" signal even at 20, and bigger lists drown out
// the rest of the context block.
const FILE_INFO_DEPENDENT_LIMIT = 20;

// Cap on symbol names mixed into the memory-retrieval query. Keeps the
// embedding focused on the most identifying tokens rather than diluting
// signal with deep symbol lists.
const FILE_INFO_MEMORY_SYMBOL_LIMIT = 5;

// Cap on memories returned by /file-info — kept small for the same
// reason as /context/retrieve: per-tool-call injection has a tight
// budget. 3 is enough to surface a directly-relevant memory without
// flooding the model's view of the tool_call.
const FILE_INFO_MEMORY_TOP_K = 3;

type FileInfoRequest = {
  /** Legacy cwd-style path. Always required for back-compat. */
  project: string;
  /**
   * Canonical project ULID. Preferred — when present it wins over
   * `project`. Older plugins omit it and send only the path.
   */
  projectId?: string;
  filePath: string;
};

type CartFileRow = {
  symbols: string;
  content_hash: string;
};

type CartImportRow = {
  source_path?: string;
  target_path?: string;
  specifier?: string;
};

type SymbolRow = { kind: string; name: string; line: number; column: number };

export const fileInfoHandler = async (c: Context) => {
  const [bodyErr, body] = await attempt(() => c.req.json<FileInfoRequest>());
  if (bodyErr) {
    log.debug({ err: bodyErr.message }, "invalid file-info JSON body");
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.project || typeof body.project !== "string") {
    return c.json({ error: "Missing required field: project" }, 400);
  }
  if (!body.filePath || typeof body.filePath !== "string") {
    return c.json({ error: "Missing required field: filePath" }, 400);
  }

  // Resolve to the canonical project id — prefers the client-sent id,
  // falls back to resolving the legacy path field. Read path: no
  // get-or-create; an unknown identifier just matches nothing.
  const resolved = await resolveProjectForQuery(
    typeof body.projectId === "string" && body.projectId.length > 0
      ? body.projectId
      : body.project,
  );
  const projectKey = resolved.project;

  const [fileErr, fileRow] = await attempt(() =>
    queryFirst<CartFileRow>(
      `SELECT symbols, content_hash FROM cart_file
        WHERE project_id = $project_id AND file_path = $file_path
        LIMIT 1`,
      { project_id: projectKey, file_path: body.filePath },
    ),
  );

  if (fileErr) {
    log.error(
      {
        err: fileErr.message,
        project: body.project,
        projectId: body.projectId,
        filePath: body.filePath,
      },
      "file-info cart_file lookup failed",
    );
    return c.json({ error: fileErr.message }, 500);
  }

  // File not indexed — return the empty shape so the hook skips injection.
  if (!fileRow) {
    return c.json({
      contentHash: "",
      symbols: [],
      imports: [],
      dependents: [],
      memories: null,
      memoryCount: 0,
    });
  }

  const [parseErr, symbols] = await attempt(() =>
    Promise.resolve(JSON.parse(fileRow.symbols) as SymbolRow[]),
  );
  const safeSymbols = parseErr ? [] : symbols;
  if (parseErr) {
    log.warn(
      { err: parseErr.message, filePath: body.filePath },
      "file-info: cart_file.symbols JSON parse failed, using empty",
    );
  }

  const [importErr, importRows] = await attempt(() =>
    queryOne<CartImportRow>(
      `SELECT target_path, specifier FROM cart_import
        WHERE project_id = $project_id AND source_path = $file_path`,
      { project_id: projectKey, file_path: body.filePath },
    ),
  );
  if (importErr) {
    log.error(
      { err: importErr.message, filePath: body.filePath },
      "file-info imports query failed",
    );
    return c.json({ error: importErr.message }, 500);
  }

  const [depErr, dependentRows] = await attempt(() =>
    queryOne<CartImportRow>(
      `SELECT source_path, specifier FROM cart_import
        WHERE project_id = $project_id AND target_path = $file_path
        LIMIT $limit`,
      {
        project_id: projectKey,
        file_path: body.filePath,
        limit: FILE_INFO_DEPENDENT_LIMIT,
      },
    ),
  );
  if (depErr) {
    log.error(
      { err: depErr.message, filePath: body.filePath },
      "file-info dependents query failed",
    );
    return c.json({ error: depErr.message }, 500);
  }

  // Memory retrieval: first-cut signal is filepath + top symbol names.
  // Embedding similarity will find memories that mention the path or any
  // of the symbols (function/type names tend to appear verbatim in
  // captured memories). Crude but useful until proper file-tagging
  // lands. Failure is non-fatal — we still return the cartographer half.
  const memoryQuery = [
    body.filePath,
    ...safeSymbols
      .slice(0, FILE_INFO_MEMORY_SYMBOL_LIMIT)
      .map((s) => s.name)
      .filter((n) => typeof n === "string" && n.length > 0),
  ].join(" ");

  const [memErr, memoryList] = await attempt(async () =>
    retrieveMemoryList(
      rootScope(await getDb()),
      [{ role: "user", content: memoryQuery }],
      {
        topK: FILE_INFO_MEMORY_TOP_K,
        includeRelated: false,
      },
    ),
  );
  if (memErr) {
    log.warn(
      { err: memErr.message, filePath: body.filePath },
      "file-info memory retrieval failed — returning without memories",
    );
  }
  const memories = memErr || !memoryList ? null : memoryList;

  const imports = importRows
    .map((r) => ({ target: r.target_path ?? "", specifier: r.specifier ?? "" }))
    .filter((i) => i.target.length > 0);
  const dependents = dependentRows
    .map((r) => ({ source: r.source_path ?? "", specifier: r.specifier ?? "" }))
    .filter((d) => d.source.length > 0);

  log.info(
    {
      project: body.project,
      projectId: body.projectId,
      projectKey,
      filePath: body.filePath,
      symbols: safeSymbols.length,
      imports: imports.length,
      dependents: dependents.length,
      memories: memories?.length ?? 0,
      contentHash: fileRow.content_hash || "(empty)",
    },
    "file-info served",
  );

  return c.json({
    contentHash: fileRow.content_hash ?? "",
    symbols: safeSymbols,
    imports,
    dependents,
    memories: memories ? formatMemoryList(memories) : null,
    // True memory count — the formatted string is multi-line per memory,
    // so the plugin cannot derive this by counting lines.
    memoryCount: memories?.length ?? 0,
  });
};
