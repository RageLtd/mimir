/**
 * Public surface for the verify gate. Host adapters import from here.
 */

export {
  type ChangedFile,
  type ChangeSet,
  collectChanges,
  resolveBase,
} from "./changes";
export {
  type CheckFailure,
  coverageCheck,
  sanityCheck,
  type TestCounts,
  testCounts,
} from "./checks";
export {
  type CommandResult,
  type CommandRunner,
  runCommand,
} from "./exec";
export { clearBlocks, MAX_BLOCKS, noteBlock, readBlocks } from "./loop-guard";
export { parseStatus, type WorkerStatus } from "./status";
export {
  type CommandRun,
  runVerify,
  type VerifyOptions,
  type VerifyOutcome,
} from "./verify";
