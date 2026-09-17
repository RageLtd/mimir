/**
 * Public surface for worker definitions and prompts. Host installers
 * import from here to render their native agent files.
 */

export {
  buildWorkerPrompt,
  extractWorkerSections,
  WORKER_SECTIONS,
} from "./prompt";
export {
  WORKER_DEFINITIONS,
  type WorkerDefinition,
  type WorkerRole,
  workerByName,
} from "./roles";
