/**
 * Session-scoped approval tracker.
 *
 * When a PreToolUse hook denies a destructive action, the model asks the
 * developer for permission. If the developer approves (in their next
 * message), the approval is recorded here so subsequent attempts for the
 * same action are allowed.
 *
 * Approvals are:
 * - Scoped to a conversation (by fingerprint)
 * - Keyed by tool name + normalized dangerous argument pattern
 * - Session-only — they don't survive across conversations
 */

import { log } from "../util/logger";

// ---------------------------------------------------------------------------
// Approval key generation
// ---------------------------------------------------------------------------

/**
 * Generate a stable approval key from a tool call.
 *
 * For bash commands, extracts the "shape" of the destructive command
 * (e.g. "bash:git push --force" → "bash:git_push_--force").
 * For other tools, uses tool name + sorted arg keys.
 */
export function approvalKey(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const command = args.command ?? args.cmd;
  if (typeof command === "string" && command) {
    // Normalize whitespace, keep the core command shape
    const normalized = command.replace(/\s+/g, " ").trim();
    return `${toolName}:${normalized}`;
  }
  // Non-bash tools: key by tool name + sorted arg keys
  const argKeys = Object.keys(args).sort().join(",");
  return `${toolName}:${argKeys}`;
}

// ---------------------------------------------------------------------------
// ApprovalTracker
// ---------------------------------------------------------------------------

export class ApprovalTracker {
  /** Map of fingerprint → Set of approved keys */
  private approvals = new Map<string, Set<string>>();

  /** Record an approval for a specific action in a conversation. */
  approve(key: string, fingerprint: string | null): void {
    const fp = fingerprint ?? "global";
    let set = this.approvals.get(fp);
    if (!set) {
      set = new Set();
      this.approvals.set(fp, set);
    }
    set.add(key);
    log.info({ key, fingerprint }, "action approved");
  }

  /**
   * Check if an action has been approved.
   * Checks both conversation-scoped and global approvals.
   * Global approvals are used when the approve_action tool can't
   * determine the fingerprint (server tool execute has no hook context).
   */
  isApproved(key: string, fingerprint: string | null): boolean {
    const fp = fingerprint ?? "global";
    // Check conversation-scoped first, then global fallback
    if (this.approvals.get(fp)?.has(key)) return true;
    if (fp !== "global" && this.approvals.get("global")?.has(key)) return true;
    return false;
  }

  /** Clear all approvals for a conversation. */
  clear(fingerprint: string | null): void {
    this.approvals.delete(fingerprint ?? "global");
  }

  /** Clear a specific approval. */
  revoke(key: string, fingerprint: string | null): void {
    const fp = fingerprint ?? "global";
    const set = this.approvals.get(fp);
    if (set) {
      set.delete(key);
      if (set.size === 0) this.approvals.delete(fp);
    }
  }

  /** Number of approved actions for a conversation. */
  count(fingerprint: string | null): number {
    return this.approvals.get(fingerprint ?? "global")?.size ?? 0;
  }

  /** Total approvals across all conversations (diagnostics). */
  get size(): number {
    let total = 0;
    for (const set of this.approvals.values()) {
      total += set.size;
    }
    return total;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: ApprovalTracker | null = null;

export function getApprovalTracker(): ApprovalTracker {
  if (!instance) instance = new ApprovalTracker();
  return instance;
}

/** Replace the global instance (for testing). */
export function setApprovalTracker(tracker: ApprovalTracker): void {
  instance = tracker;
}
