/**
 * Public surface for the rule engine.
 *
 * Backend adapters and the agent layer import only from this entry —
 * internal modules (matcher, builtins, format, loader, runner) stay
 * private to the engine.
 */
export { loadRules } from "./loader";
export { runRules, runAndFormat, eventMatchesTool } from "./runner";
export { formatFindings, formatLoadErrors } from "./format";
export type {
  Condition,
  CompiledCondition,
  DetectorContext,
  Finding,
  LoadError,
  LoadResult,
  Operator,
  RuleEntry,
  RuleEvent,
  Violation,
} from "./types";
