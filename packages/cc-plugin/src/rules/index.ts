/**
 * Public surface for the rule engine. Ported from
 * packages/acp/src/rules/index.ts.
 *
 * The rules-hook adapter imports only from this entry — internal
 * modules (matcher, builtins, format, loader, runner) stay private to
 * the engine.
 */

export { formatFindings, formatLoadErrors } from "./format";
export { loadRules } from "./loader";
export { eventMatchesTool, runAndFormat, runRules } from "./runner";
export type {
  CompiledCondition,
  Condition,
  DetectorContext,
  Finding,
  LoadError,
  LoadResult,
  Operator,
  RuleEntry,
  RuleEvent,
  Violation,
} from "./types";
