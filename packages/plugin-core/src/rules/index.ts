/**
 * Public surface for the rule engine.
 *
 * Backend adapters and the agent layer import only from this entry —
 * internal modules (matcher, builtins, format, loader, runner) stay
 * private to the engine.
 */

export { formatFindings, formatLoadErrors } from "./format";
export { loadRules } from "./loader";
export {
  formatRulesForPrompt,
  formatScopedRules,
  type ProjectRulesEntry,
  readProjectRules,
  scopedRulesFor,
} from "./project-rules";
export { eventMatchesTool, runAndFormat, runRules } from "./runner";
export {
  conventionFor,
  isTestFile,
  TEST_CONVENTIONS,
  type TestConvention,
  type TestLanguage,
  type TestSignals,
  testSignals,
} from "./test-conventions";
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
