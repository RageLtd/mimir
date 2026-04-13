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

export class DenialTracker {
  private records = new Map<string, DenialRecord>();
  private maxConsecutive: number;

  constructor(maxConsecutive = DEFAULT_MAX_CONSECUTIVE) {
    this.maxConsecutive = maxConsecutive;
  }

  /** Build a tracking key from tool name + normalized args */
  static key(toolName: string, args: Record<string, unknown>): string {
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

  /** Scope key to a specific conversation */
  private scopedKey(key: string, fingerprint: string | null): string {
    return `${fingerprint ?? "global"}:${key}`;
  }

  /**
   * Record a denial. Returns whether the model has exceeded the threshold.
   */
  recordDenial(
    toolName: string,
    args: Record<string, unknown>,
    fingerprint: string | null,
  ): { exceeded: boolean; count: number } {
    const key = this.scopedKey(DenialTracker.key(toolName, args), fingerprint);

    const existing = this.records.get(key);
    const count = (existing?.count ?? 0) + 1;

    this.records.set(key, { count, lastDeniedAt: Date.now() });

    const exceeded = count >= this.maxConsecutive;
    if (exceeded) {
      log.warn(
        { toolName, count, threshold: this.maxConsecutive },
        "consecutive denial threshold exceeded",
      );
    }

    return { exceeded, count };
  }

  /**
   * Clear denials for a conversation (e.g. when a different tool succeeds,
   * or when the developer approves an action).
   */
  clearForConversation(fingerprint: string | null): void {
    const prefix = `${fingerprint ?? "global"}:`;
    for (const key of this.records.keys()) {
      if (key.startsWith(prefix)) {
        this.records.delete(key);
      }
    }
  }

  /**
   * Clear a specific denial record (e.g. after developer approval).
   */
  clearSpecific(
    toolName: string,
    args: Record<string, unknown>,
    fingerprint: string | null,
  ): void {
    const key = this.scopedKey(DenialTracker.key(toolName, args), fingerprint);
    this.records.delete(key);
  }

  /** Prune old records (housekeeping, call periodically) */
  prune(maxAgeMs = 30 * 60 * 1000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [key, record] of this.records) {
      if (record.lastDeniedAt <= cutoff) {
        this.records.delete(key);
      }
    }
  }
}
