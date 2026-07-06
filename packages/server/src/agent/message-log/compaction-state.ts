/**
 * Compaction state management for the global message log.
 *
 * Tracks token accumulation and compaction progress independently
 * from message persistence operations.
 */

import { config } from "../../config";
import { getDb, queryFirst, queryOne } from "../../db/surreal";
import { log } from "../../util/logger";
import { getContextWindow } from "../provider/query";

export interface CompactionState {
  id: string;
  tokens_since_last: number;
  is_compacting: boolean;
  last_compaction?: string;
  last_prompt_tokens: number;
  updated_at: string;
}

/** SQL reference to an org's compaction-state record — per-org so one tenant's
 *  stream and lock never interfere with another's (MIM-66). Bind `$org`. */
const STATE_REF = "type::thing('compaction_state', $org)";

/**
 * Get an org's compaction state.
 */
export async function getCompactionState(orgId: string) {
  return queryFirst<CompactionState>(`SELECT * FROM ${STATE_REF}`, {
    org: orgId,
  });
}

/**
 * Update token count since last compaction.
 * Uses atomic compare-and-set to prevent race conditions between concurrent requests.
 * Returns true if compaction threshold is reached.
 */
export async function updateTokenCount(
  orgId: string,
  promptTokens: number,
  modelId?: string,
) {
  const modelContextWindow = modelId ? getContextWindow(modelId) : undefined;
  // Cap at config.context.maxTokens regardless of what the model advertises.
  // Opus advertises 1M on some tiers, but pricing jumps 4x past 256k — we
  // don't want compaction waiting until 800k to fire. Smaller windows
  // (local models, etc.) still use their own ceiling.
  const maxTokens = Math.min(
    modelContextWindow ?? config.context.maxTokens,
    config.context.maxTokens,
  );
  const threshold = maxTokens * config.context.compactionThreshold;

  // Get current state
  const currentState = await getCompactionState(orgId);

  // Initialize state if it doesn't exist
  if (!currentState) {
    const db = await getDb();
    await db.query(
      `CREATE ${STATE_REF} SET
        org_id = $org,
        tokens_since_last = 0,
        is_compacting = false,
        last_prompt_tokens = 0,
        updated_at = time::now()`,
      { org: orgId },
    );
  }

  const lastPromptTokens = currentState?.last_prompt_tokens ?? 0;
  const lastSinceCompaction = currentState?.tokens_since_last ?? 0;

  // Calculate delta:
  // - If last_prompt_tokens == 0 (post-compaction baseline), set baseline without counting
  // - If prompt grew, add only the difference (new messages)
  // - If prompt shrank (e.g., context trimmed), use full prompt as new baseline
  let delta: number;
  if (lastPromptTokens === 0) {
    // Post-compaction: establish baseline without counting these tokens
    delta = 0;
  } else if (promptTokens > lastPromptTokens) {
    delta = promptTokens - lastPromptTokens;
  } else if (promptTokens === lastPromptTokens) {
    // Same value reported again (retry, duplicate call) — nothing new
    delta = 0;
  } else {
    // Prompt shrank (context trimmed, compaction on client side) — new baseline
    delta = promptTokens;
  }

  // Atomic update: only apply if last_prompt_tokens hasn't changed since we read it.
  // This prevents concurrent requests from double-counting the same tokens.
  const state = await queryFirst<CompactionState>(
    `UPDATE ${STATE_REF}
     SET
       tokens_since_last = $newSince,
       last_prompt_tokens = $promptTokens,
       updated_at = time::now()
     WHERE last_prompt_tokens = $lastPromptTokens
     RETURN AFTER`,
    {
      org: orgId,
      promptTokens,
      lastPromptTokens,
      newSince: lastSinceCompaction + delta,
    },
  );

  // If the update didn't apply (last_prompt_tokens changed), retry once
  if (!state) {
    // Another request updated it concurrently. Read the fresh state.
    const freshState = await getCompactionState(orgId);
    if (!freshState) {
      log.error("failed to get compaction state after retry");
      return {
        needsCompaction: false,
        state: {
          id: `compaction_state:${orgId}`,
          tokens_since_last: 0,
          is_compacting: false,
          last_prompt_tokens: 0,
          updated_at: new Date().toISOString(),
        },
      };
    }

    const needsCompaction =
      freshState.tokens_since_last >= threshold && !freshState.is_compacting;

    log.info(
      {
        promptTokens,
        lastPromptTokens: freshState.last_prompt_tokens,
        sinceLast: freshState.tokens_since_last,
        threshold,
        needsCompaction,
        concurrent: true,
      },
      "token count updated (concurrent)",
    );

    return { needsCompaction, state: freshState };
  }

  const needsCompaction =
    state.tokens_since_last >= threshold && !state.is_compacting;

  log.info(
    {
      promptTokens,
      lastPromptTokens,
      delta,
      sinceLast: state.tokens_since_last,
      threshold,
      needsCompaction,
    },
    "token count updated",
  );

  return { needsCompaction, state };
}

/**
 * Mark compaction as started (prevents concurrent compactions).
 * Returns true if successfully acquired the lock, false if already compacting.
 */
export async function startCompaction(orgId: string) {
  const db = await getDb();

  // Try to create state if it doesn't exist
  await db.query(
    `INSERT IGNORE INTO compaction_state { id: ${STATE_REF}, org_id: $org, tokens_since_last: 0, is_compacting: false, last_prompt_tokens: 0 }`,
    { org: orgId },
  );

  // Only set is_compacting = true if it's currently false (atomic lock acquisition)
  const result = await queryOne<CompactionState>(
    `UPDATE ${STATE_REF} SET is_compacting = true, updated_at = time::now() WHERE is_compacting = false`,
    { org: orgId },
  );

  // If we updated a record, we acquired the lock
  const success = result.length > 0;
  log.info({ success }, "started compaction");
  return success;
}

/**
 * Clear stale compaction lock.
 * If is_compacting has been true for more than staleMinutes, the compaction
 * was interrupted and the lock is stale.
 *
 * Call this at server startup to recover from crashes mid-compaction.
 */
export async function clearStaleCompaction(staleMinutes: number = 5) {
  // Boot-time recovery across EVERY org's state — no id filter, so a crash
  // mid-compaction in any tenant is cleared. Per-org records (MIM-66) mean
  // this now sweeps the whole table rather than a single global row.
  const result = await queryOne<CompactionState>(
    `UPDATE compaction_state
     SET is_compacting = false, updated_at = time::now()
     WHERE is_compacting = true AND updated_at < time::now() - ${staleMinutes}m
     RETURN AFTER`,
  );

  const cleared = result.length > 0;
  if (cleared) {
    log.info({ staleMinutes }, "cleared stale compaction lock");
  }
  return cleared;
}

/**
 * Reset compaction state after completion.
 */
export async function finishCompaction(orgId: string) {
  const db = await getDb();

  await db.query(
    `UPDATE ${STATE_REF} SET
      tokens_since_last = 0,
      is_compacting = false,
      last_prompt_tokens = 0,
      last_compaction = time::now(),
      updated_at = time::now()`,
    { org: orgId },
  );

  log.debug("compaction state reset");
}
