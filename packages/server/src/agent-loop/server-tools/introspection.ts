import { tool } from "ai";
import { z } from "zod";
import { log } from "../../util/logger";
import { CACHE_CONTROL } from "./shared";

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
// Execute
// ---------------------------------------------------------------------------

export const executeReadLogs = async ({
  lines,
  filter,
  since,
}: z.infer<typeof ReadLogsSchema>) => {
  const maxLines = Math.min(lines ?? 100, 500);

  // Build docker logs command
  const args = ["logs"];
  if (since) {
    args.push("--since", since);
  } else {
    args.push("--tail", String(maxLines));
  }

  args.push("mimir-server-mimir-1");

  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  await proc.exited;

  if (proc.exitCode !== 0) {
    log.warn({ exitCode: proc.exitCode, stderr }, "docker logs failed");
    return {
      success: false,
      error: stderr.trim() || "docker logs command failed",
      lines: [],
    };
  }

  // Docker sends log output to stderr when using --timestamps on some versions.
  // Combine both streams so we catch everything regardless.
  const raw = (stdout + stderr)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Apply optional filter
  const filtered = filter
    ? raw.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : raw;

  // Cap at maxLines from the tail
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
      "Read Mimir's own runtime logs from Docker. Use this to self-diagnose issues: check compaction state, token counts, memory retrieval scores, context assembly, errors, or any recent warnings. Call proactively when something seems off — stuck behaviour, missing context, unexpected responses.",
    inputSchema: ReadLogsSchema,
    providerOptions: CACHE_CONTROL,
    execute: executeReadLogs,
  }),
};
