/**
 * Gate output as the coordinator and the worker read it.
 */

import type { ChangedFile } from "./changes";
import type { TestCounts } from "./checks";
import type { CommandRun } from "./verify";

export const formatBlockReason = (
  reason: string,
  blocks: number,
  max: number,
) => {
  const header =
    blocks >= max
      ? `⛔ Verify gate: blocked ${blocks}/${max} times — giving up. Stop now and end with STATUS: failed so the coordinator can escalate.`
      : `⛔ Verify gate (block ${blocks}/${max}): this "done" is not accepted.`;
  return [
    header,
    "",
    reason,
    "",
    "Fix it, then finish again with STATUS: done.",
  ].join("\n");
};

export const formatPassReport = (input: {
  readonly base: string;
  readonly files: readonly ChangedFile[];
  readonly counts: TestCounts;
  readonly runs: readonly CommandRun[];
}) => {
  const files = input.files.map((f) => `  ${f.status} ${f.path}`).join("\n");
  const runs = input.runs
    .map((r) => `  ✓ ${r.kind}: ${r.command}  (${r.root})`)
    .join("\n");
  return [
    "✅ Verify gate passed.",
    `Base: ${input.base.slice(0, 12)}`,
    `Changed files (${input.files.length}):`,
    files,
    `Test functions: ${input.counts.before} → ${input.counts.after}`,
    "Commands:",
    runs.length > 0 ? runs : "  (none)",
  ].join("\n");
};
