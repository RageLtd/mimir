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
export function approvalKey(toolName: string, args: Record<string, unknown>) {
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

export interface ApprovalTracker {
  approve(key: string, fingerprint: string | null): void;
  isApproved(key: string, fingerprint: string | null): boolean;
  clear(fingerprint: string | null): void;
  revoke(key: string, fingerprint: string | null): void;
  count(fingerprint: string | null): number;
  readonly size: number;
}

export function createApprovalTracker(): ApprovalTracker {
  const approvals = new Map<string, Set<string>>();

  return {
    approve(key, fingerprint) {
      const fp = fingerprint ?? "global";
      let set = approvals.get(fp);
      if (!set) {
        set = new Set();
        approvals.set(fp, set);
      }
      set.add(key);
      log.info({ key, fingerprint }, "action approved");
    },

    isApproved(key, fingerprint) {
      const fp = fingerprint ?? "global";
      // Check conversation-scoped first, then global fallback
      if (approvals.get(fp)?.has(key)) return true;
      if (fp !== "global" && approvals.get("global")?.has(key)) return true;
      return false;
    },

    clear(fingerprint) {
      approvals.delete(fingerprint ?? "global");
    },

    revoke(key, fingerprint) {
      const fp = fingerprint ?? "global";
      const set = approvals.get(fp);
      if (set) {
        set.delete(key);
        if (set.size === 0) approvals.delete(fp);
      }
    },

    count(fingerprint) {
      return approvals.get(fingerprint ?? "global")?.size ?? 0;
    },

    get size() {
      let total = 0;
      for (const set of approvals.values()) {
        total += set.size;
      }
      return total;
    },
  };
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let instance: ApprovalTracker | null = null;

export function getApprovalTracker() {
  if (!instance) instance = createApprovalTracker();
  return instance;
}

/** Replace the global instance (for testing). */
export function setApprovalTracker(tracker: ApprovalTracker) {
  instance = tracker;
}
