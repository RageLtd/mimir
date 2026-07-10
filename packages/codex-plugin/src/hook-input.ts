/**
 * Shared stdin reader for Codex hook processes. Codex writes the hook
 * payload as a single JSON object to the hook command's stdin (same
 * contract as Claude Code). Malformed or empty input degrades to {} —
 * every hook treats missing fields as "skip quietly".
 */

import { attemptSync } from "@mimir/plugin-core/result";

const readStdin = async () => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

export const readHookInput = async <T extends object>() => {
  const raw = await readStdin();
  if (raw.trim().length === 0) return {} as T;
  const [err, parsed] = attemptSync(() => JSON.parse(raw) as T);
  return err ? ({} as T) : parsed;
};
