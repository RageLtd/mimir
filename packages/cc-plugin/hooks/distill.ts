/**
 * The two-phase run of a distillation leg, shared by the lifecycle legs
 * (lifecycle.ts) and the precompact `prompt.submit` starts for a reset no
 * compaction announced (submit.ts).
 *
 * Pure: `$` never enters this file. A hook hands in what it needs from `$`
 * as `Host`, built where `$` is in scope.
 */

import type {
  ModelCompleteRequest,
  ModelCompleteResult,
  ProcessRunResult,
} from "claude-code";
import {
  type Completion,
  completionAsk,
  completionOutcome,
  completionRefusal,
  type MimirCcCall,
  mimirCcCall,
  PRECOMPACT_COMPLETION_TIMEOUT_MS,
  parseHookOutput,
} from "./binary";

/** BYOK summarise (120 s) then extract (60 s), sequential in the binary. */
export const PRECOMPACT_TIMEOUT_MS = 200_000;

export type Leg = {
  readonly name: string;
  /** One run of the leg's subcommand on a payload. */
  readonly call: (payload: unknown) => MimirCcCall;
  readonly completionTimeoutMs: number;
};

/** What a leg needs from `$`: the binary, the session's model, the status line. */
export type Host = {
  /** Writes the call's payload file, then runs the binary on it. */
  readonly run: (call: MimirCcCall) => Promise<ProcessRunResult>;
  readonly complete: (
    request: ModelCompleteRequest,
  ) => Promise<ModelCompleteResult>;
  readonly status: (text: string) => void;
};

export const precompactLeg = (home: string) =>
  ({
    name: "precompact",
    call: (payload) =>
      mimirCcCall(home, "precompact", payload, PRECOMPACT_TIMEOUT_MS),
    completionTimeoutMs: PRECOMPACT_COMPLETION_TIMEOUT_MS,
  }) satisfies Leg;

/**
 * Runs a distillation leg. When it answers `requests`, each runs on the
 * session's model in parallel and the leg runs again with the replies as
 * `completions`; the last run is the one to settle on. A completion the
 * engine refuses to send goes back as its error, so the others still land.
 */
export const distill = async (
  host: Host,
  leg: Leg,
  payload: Record<string, unknown>,
) => {
  const run = (input: unknown) => host.run(leg.call(input));
  const first = await run(payload);
  if (first.exitCode !== 0) return first;
  const { requests } = parseHookOutput(first.stdout);
  if (requests === undefined) return first;
  const replies = await Promise.all(
    Object.entries(requests).map(async ([key, request]) => {
      const outcome = await host
        .complete(completionAsk(request, leg.completionTimeoutMs))
        .then(completionOutcome, completionRefusal);
      return [key, outcome] satisfies [string, Completion];
    }),
  );
  const second = await run({
    ...payload,
    completions: Object.fromEntries(replies),
  });
  if (
    second.exitCode === 0 &&
    parseHookOutput(second.stdout).requests !== undefined
  )
    host.status(`mimir: ${leg.name} asked for completions twice`);
  return second;
};
