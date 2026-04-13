/**
 * Cartographer post-edit trigger — PostToolUse hook.
 *
 * After any tool call that modifies files, invalidates the file's
 * Cartographer index entry so the next indexing pass re-processes it.
 *
 * Strategy: delete the cart_file record and its cart_import edges for
 * the modified file. Cartographer's normal indexing cycle will re-add
 * them with fresh symbol/import data. Between deletion and re-index,
 * queries return nothing (better than stale data).
 */

import { getDb } from "../../db/surreal";
import { log } from "../../util/logger";
import type { HookRegistry } from "../registry";
import type { PostToolUseContext, PostToolUseResult } from "../types";

// ---------------------------------------------------------------------------
// File path extraction
// ---------------------------------------------------------------------------

/**
 * Extract the file path from tool arguments.
 * Handles various naming conventions across different client tools.
 */
function extractFilePath(
  toolName: string,
  args: Record<string, unknown>,
): string | null {
  // Common arg names for file paths
  for (const key of ["file_path", "path", "filePath", "filename", "file"]) {
    const val = args[key];
    if (typeof val === "string" && val) return val;
  }

  // For bash/shell tools, try to extract paths from the command
  if (toolName === "bash" || toolName === "terminal" || toolName === "shell") {
    const command = (args.command ?? args.cmd) as string | undefined;
    if (!command) return null;

    // Detect file-writing shell commands and extract target path
    // tee output, redirect output, cp/mv target
    const redirectMatch = command.match(/>\s*(\S+)\s*$/);
    if (redirectMatch?.[1]) return redirectMatch[1];

    const teeMatch = command.match(/\btee\s+(\S+)/);
    if (teeMatch?.[1]) return teeMatch[1];
  }

  return null;
}

// ---------------------------------------------------------------------------
// Index invalidation
// ---------------------------------------------------------------------------

/**
 * Invalidate a file's Cartographer index entry.
 * Deletes the cart_file record and its import edges so the next
 * Cartographer indexing pass re-processes the file.
 */
async function invalidateFile(
  filePath: string,
  project: string | null,
): Promise<void> {
  try {
    const db = await getDb();

    // Delete import edges (both directions) for this file
    if (project) {
      await db.query(
        `DELETE cart_import WHERE project = $project AND (source_path = $path OR target_path = $path)`,
        { project, path: filePath },
      );
      await db.query(
        `DELETE cart_file WHERE project = $project AND file_path = $path`,
        { project, path: filePath },
      );
    } else {
      // Without project context, match by file_path alone
      await db.query(
        `DELETE cart_import WHERE source_path = $path OR target_path = $path`,
        { path: filePath },
      );
      await db.query(`DELETE cart_file WHERE file_path = $path`, {
        path: filePath,
      });
    }

    log.debug({ filePath, project }, "invalidated Cartographer index entry");
  } catch (err) {
    // Non-fatal — stale index is better than crashing the hook chain
    log.warn(
      { err, filePath, project },
      "failed to invalidate Cartographer index entry",
    );
  }
}

// ---------------------------------------------------------------------------
// PostToolUse hook
// ---------------------------------------------------------------------------

/** Tool names that modify files (client-side tools from editors) */
const FILE_WRITE_TOOLS = new Set([
  "write",
  "Write",
  "write_file",
  "WriteFile",
  "edit",
  "Edit",
  "edit_file",
  "EditFile",
  "str_replace",
  "create",
  "Create",
  "create_file",
  "CreateFile",
  "delete",
  "Delete",
  "delete_file",
  "DeleteFile",
]);

function cartographerPostHook(ctx: PostToolUseContext): PostToolUseResult {
  const filePath = extractFilePath(ctx.toolName, ctx.args);
  if (!filePath) return;

  // Only invalidate for tools that modify files
  if (!FILE_WRITE_TOOLS.has(ctx.toolName)) return;

  // Fire-and-forget — don't block the response
  invalidateFile(filePath, ctx.project).catch((err) =>
    log.error({ err, filePath }, "cartographer invalidation error"),
  );
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCartographerHook(registry: HookRegistry): void {
  registry.onPostToolUse(cartographerPostHook, {
    type: "client",
  });
}
