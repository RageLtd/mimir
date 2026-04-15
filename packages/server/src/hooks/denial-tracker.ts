/**
 * Consecutive denial tracker — circuit breaker for misbehaving models.
 *
 * Tracks how many times the same action has been denied in a row.
 * After N consecutive denials (default 3), the escalation message changes
 * to a hard stop that tells the model to ask the developer for permission
 * rather than retrying.
 */

import { log } from "../util/logger";

/** Default threshold before escalating */
const DEFAULT_MAX_CONSECUTIVE = 3;

interface DenialRecord {
  count: number;
  lastDeniedAt: number;
}

// ---------------------------------------------------------------------------
// Key generation (standalone, no class dependency)
// ---------------------------------------------------------------------------

/** Build a tracking key from tool name + normalized args */
export function denialKey(toolName: string, args: Record<string, unknown>) {
  // For bash commands, use the command string as the key
  const command = args.command ?? args.cmd ?? "";
  if (typeof command === "string" && command) {
    // Normalize: strip whitespace variations, keep the core command
    const normalized = command.replace(/\s+/g, " ").trim();
    return `${toolName}:${normalized}`;
  }
  // For other tools, use tool name + sorted arg keys
  const argKeys = Object.keys(args).sort().join(",");
  return `${toolName}:${argKeys}`;
}

// ---------------------------------------------------------------------------
// DenialTracker
// ---------------------------------------------------------------------------

export interface DenialTracker {
  recordDenial(
    toolName: string,
    args: Record<string, unknown>,
    fingerprint: string | null,
  ): { exceeded: boolean; count: number };
  clearForConversation(fingerprint: string | null): void;
  clearSpecific(
    toolName: string,
    args: Record<string, unknown>,
    fingerprint: string | null,
  ): void;
  prune(maxAgeMs?: number): void;
}

export function createDenialTracker(
  maxConsecutive = DEFAULT_MAX_CONSECUTIVE,
): DenialTracker {
  const records = new Map<string, DenialRecord>();

  function scopedKey(key: string, fingerprint: string | null) {
    return `${fingerprint ?? "global"}:${key}`;
  }

  return {
    recordDenial(toolName, args, fingerprint) {
      const key = scopedKey(denialKey(toolName, args), fingerprint);

      const existing = records.get(key);
      const count = (existing?.count ?? 0) + 1;

      records.set(key, { count, lastDeniedAt: Date.now() });

      const exceeded = count >= maxConsecutive;
      if (exceeded) {
        log.warn(
          { toolName, count, threshold: maxConsecutive },
          "consecutive denial threshold exceeded",
        );
      }

      return { exceeded, count };
    },

    clearForConversation(fingerprint) {
      const prefix = `${fingerprint ?? "global"}:`;
      for (const key of records.keys()) {
        if (key.startsWith(prefix)) {
          records.delete(key);
        }
      }
    },

    clearSpecific(toolName, args, fingerprint) {
      const key = scopedKey(denialKey(toolName, args), fingerprint);
      records.delete(key);
    },

    prune(maxAgeMs = 30 * 60 * 1000) {
      const cutoff = Date.now() - maxAgeMs;
      for (const [key, record] of records) {
        if (record.lastDeniedAt <= cutoff) {
          records.delete(key);
        }
      }
    },
  };
}
