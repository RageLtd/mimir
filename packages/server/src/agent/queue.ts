/**
 * LLM-call serialization queue.
 *
 * Under the single-brain architecture there is exactly one ongoing
 * conversation. When two clients request simultaneously, letting both
 * LLM calls run in parallel would interleave their writes to the global
 * message log — an assistant reply might land "next to" a user message
 * it wasn't responding to, and the next read would see an incoherent
 * conversation.
 *
 * This module serializes LLM calls behind a FIFO Promise chain. Each
 * caller's work runs after the prior caller's work resolves (or fails).
 * Errors are not propagated down the chain — each caller sees its own
 * error, the chain continues for the next waiter.
 *
 * Writes to the log remain unordered w.r.t. each other (append-only,
 * nanosecond-timestamped record IDs keep collisions impossible). The
 * queue is specifically on the LLM-interaction phase.
 */

import { log } from "../util/logger";

let chain: Promise<void> = Promise.resolve();
let pending = 0;

/**
 * Enqueue an LLM interaction. Returns a promise that resolves with the
 * work's result once the prior queued work has settled.
 */
export function enqueueLlmCall<T>(fn: () => Promise<T>) {
  pending += 1;
  const depth = pending;
  if (depth > 1) {
    log.debug({ depth }, "llm call queued behind in-flight work");
  }
  const next = chain.then(() => fn());
  // Keep the chain advancing regardless of success/failure of `next`.
  // Each caller handles its own rejection; the chain itself never rejects.
  chain = next.then(
    () => {
      pending -= 1;
    },
    () => {
      pending -= 1;
    },
  );
  return next;
}

/** Current depth of queued LLM calls (in-flight + waiting). */
export function currentQueueDepth() {
  return pending;
}
