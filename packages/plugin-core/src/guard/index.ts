/**
 * Public surface for the role guard. Host adapters import from here.
 */

export {
  allowTaskDeletions,
  allowTaskRemovals,
  type CoordinatorState,
  clearCoordinatorState,
  coordinatorStatePath,
  REFACTOR_LABEL,
  readCoordinatorState,
  TASK_ALLOWANCES,
  writeCoordinatorState,
} from "./coordinator-state";
export {
  GUARD_ROLES,
  type GuardContext,
  type GuardDecision,
  type GuardRole,
  guardDecision,
  isGuardRole,
  isSecretPath,
  SECRET_PATH,
  SECRET_PATH_GLOBS,
} from "./decision";
