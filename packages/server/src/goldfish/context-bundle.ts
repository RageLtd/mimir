/**
 * Shared retrieval bundle — memories + summaries + playbooks in one call.
 *
 * The CC-facing context routes (/v1/context/assemble, /v1/context/retrieve)
 * both need the same trio with different budgets. Centralizing the
 * Promise.all keeps the retrieval shape canonical: one synthetic user
 * message for the memory query, playbooks keyed on the project, summaries
 * newest-first.
 */

import type { OrgScope } from "../db/scope";
import { retrieveMemories } from "./memory";
import { buildPlaybookContext } from "./playbook";
import { getLastSummaries } from "./store";

export async function retrieveContextBundle(
  scope: OrgScope,
  query: string,
  opts: {
    projectIdentifier?: string;
    topK?: number;
    includeRelated?: boolean;
    summaryCount?: number;
  } = {},
) {
  const [memories, summaries, playbooks] = await Promise.all([
    retrieveMemories(scope, [{ role: "user", content: query }], {
      topK: opts.topK,
      includeRelated: opts.includeRelated,
    }),
    getLastSummaries(scope, opts.summaryCount ?? 3),
    buildPlaybookContext(scope, query, {
      projectIdentifier: opts.projectIdentifier,
    }),
  ]);
  return { memories, summaries, playbooks };
}
