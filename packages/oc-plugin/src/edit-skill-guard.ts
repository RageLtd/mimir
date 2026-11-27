/**
 * The skill-before-edit rule for OpenCode. A `skill` call is recorded for
 * the session that made it; a file write whose skill that session has not
 * loaded is refused by a throw. Every OpenCode session, a worker's
 * included, keeps its own record, so a parent's skills never cover its
 * worker. The implementer in a task marked as a refactor also needs
 * `refactor` for a source file.
 */

import {
  editSkillDecision,
  readCoordinatorState,
  readLoadedSkills,
  recordLoadedSkill,
} from "@mimir/plugin-core/guard";
import type { normalizeToolCalls } from "./tool-map";
import type { SessionRoles } from "./worker-hooks";

type ToolCall = ReturnType<typeof normalizeToolCalls>[number];

const FILE_WRITERS = new Set(["Edit", "Write", "MultiEdit"]);

/** OpenCode names a skill by `id`; older versions used `name`. */
const skillName = ({ id, name }: Record<string, unknown>) => {
  const skill = id ?? name;
  return typeof skill === "string" && skill ? skill : null;
};

/** True when the session is the implementer in a task marked as a refactor. */
const implementsRefactor = async (sessionId: string, roles: SessionRoles) => {
  if ((await roles.workerRole(sessionId)) !== "impl") return false;
  const state = await readCoordinatorState(
    await roles.coordinatorSession(sessionId),
  );
  return state?.task?.refactor === true;
};

export const enforceEditSkill = async (
  sessionId: string,
  call: ToolCall,
  roles: SessionRoles,
) => {
  if (call.toolName === "skill") {
    const skill = skillName(call.toolInput);
    if (skill) await recordLoadedSkill({ sessionId }, skill);
    return;
  }
  const path = call.toolInput.file_path;
  if (!FILE_WRITERS.has(call.toolName) || typeof path !== "string" || !path)
    return;
  const decision = editSkillDecision(
    path,
    await readLoadedSkills({ sessionId }),
    { refactor: await implementsRefactor(sessionId, roles) },
  );
  if (!decision.allow) throw new Error(decision.reason);
};
