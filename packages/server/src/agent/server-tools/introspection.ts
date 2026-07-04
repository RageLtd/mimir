/**
 * Self-introspection — read Mimir's own runtime logs.
 *
 * Reads the pino JSON file log (util/logger.ts writes every level to
 * LOG_FILE_PATH) instead of shelling out to `docker logs` (MIM-68): the
 * docker.sock mount was a container-escape liability and doesn't exist at
 * all on Railway. The file path works in any deployment — container,
 * homelab, bare bun.
 */

import { tool } from "ai";
import { z } from "zod";
import { LOG_FILE_PATH, log } from "../../util/logger";
import { attempt, attemptSync } from "../../util/result";
import { CACHE_CONTROL } from "./shared";

/** Bounded tail read — plenty for the 500-line response cap without ever
 *  pulling a multi-hundred-MB log into memory. */
const TAIL_READ_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const ReadLogsSchema = z.object({
  lines: z
    .number()
    .optional()
    .describe("Number of recent log lines to return (default: 100, max: 500)"),
  filter: z
    .string()
    .optional()
    .describe(
      "Optional string to filter log lines by (case-insensitive substring match)",
    ),
  since: z
    .string()
    .optional()
    .describe(
      "Only return logs since this time, e.g. '10m', '1h', '2026-04-05T00:00:00Z'",
    ),
});

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Parse a `since` argument to an epoch-ms cutoff. Accepts docker-style
 * durations (`30s`, `10m`, `2h`, `1d`) and anything Date.parse understands.
 * Returns null for unparseable input.
 */
export function parseSince(since: string, now = Date.now()) {
  const duration = since.match(/^(\d+)([smhd])$/);
  if (duration?.[1] && duration[2]) {
    const n = parseInt(duration[1], 10);
    switch (duration[2]) {
      case "s":
        return now - n * 1000;
      case "m":
        return now - n * 60_000;
      case "h":
        return now - n * 3_600_000;
      case "d":
        return now - n * 86_400_000;
      default:
        return null;
    }
  }
  const parsed = Date.parse(since);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Filter raw log lines. `sinceMs` keeps only pino JSON lines whose `time`
 * field is at or after the cutoff — lines that aren't parseable JSON with a
 * numeric `time` are dropped under a since filter, because their age is
 * unknowable. Without `sinceMs`, unparseable lines pass through untouched.
 */
export function filterLogLines(
  lines: readonly string[],
  opts: { filter?: string; sinceMs?: number | null } = {},
) {
  let result = [...lines];

  if (opts.sinceMs != null) {
    const cutoff = opts.sinceMs;
    result = result.filter((line) => {
      const [err, parsed] = attemptSync(
        () => JSON.parse(line) as { time?: unknown },
      );
      if (err || typeof parsed !== "object" || parsed === null) return false;
      return typeof parsed.time === "number" && parsed.time >= cutoff;
    });
  }

  if (opts.filter) {
    const needle = opts.filter.toLowerCase();
    result = result.filter((line) => line.toLowerCase().includes(needle));
  }

  return result;
}

/**
 * Read the last `maxBytes` of a file and return its complete lines. When
 * the read starts mid-file, the first (almost certainly partial) line is
 * dropped so callers never see a truncated JSON record.
 */
export async function readLogTail(path: string, maxBytes = TAIL_READ_BYTES) {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) return null;

  const size = file.size;
  const start = Math.max(0, size - maxBytes);
  const text = await file.slice(start).text();

  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return start > 0 ? lines.slice(1) : lines;
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export const executeReadLogs = async ({
  lines,
  filter,
  since,
}: z.infer<typeof ReadLogsSchema>) => {
  const maxLines = Math.min(lines ?? 100, 500);

  const sinceMs = since ? parseSince(since) : null;
  if (since && sinceMs === null) {
    return {
      success: false,
      error: `Unparseable 'since' value "${since}" — use '30s', '10m', '2h', '1d', or an ISO date`,
      lines: [],
    };
  }

  const [readErr, raw] = await attempt(() => readLogTail(LOG_FILE_PATH));
  if (readErr) {
    log.warn({ err: readErr.message, path: LOG_FILE_PATH }, "log read failed");
    return {
      success: false,
      error: `Failed to read log file ${LOG_FILE_PATH}: ${readErr.message}`,
      lines: [],
    };
  }
  if (raw === null) {
    return {
      success: false,
      error: `Log file ${LOG_FILE_PATH} does not exist — check MIMIR_LOG_FILE`,
      lines: [],
    };
  }

  const filtered = filterLogLines(raw, { filter, sinceMs });
  const result = filtered.slice(-maxLines);

  log.info(
    { total: raw.length, filtered: result.length, filter, since },
    "read_mimir_logs",
  );

  return {
    success: true,
    error: null,
    totalLines: raw.length,
    returnedLines: result.length,
    lines: result,
  };
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const introspectionTools = {
  read_mimir_logs: tool({
    description:
      "Read Mimir's own runtime logs from its log file. Use this to self-diagnose issues: check compaction state, token counts, memory retrieval scores, context assembly, errors, or any recent warnings. Call proactively when something seems off — stuck behaviour, missing context, unexpected responses.",
    inputSchema: ReadLogsSchema,
    providerOptions: CACHE_CONTROL,
    execute: executeReadLogs,
  }),
};
