/**
 * The skills each agent loop has loaded — one small JSON array per loop
 * under `~/.mimir/agents/skills/`. The main loop and every subagent keep
 * their own record, so a skill one loop loaded never satisfies another.
 *
 * Absent → nothing loaded. Unparseable → a throw naming the record: the
 * edit-skill rule must not quietly treat a broken record as empty.
 */

import { join } from "node:path";
import { attempt } from "../result";
import { errMessage, mimirHome } from "../util";

export type SkillLoop = {
  readonly sessionId: string;
  /** Absent for the main loop. */
  readonly agentId?: string;
};

const safeId = (id: string) => id.replace(/[^A-Za-z0-9_.-]/g, "_");

export const loadedSkillsPath = ({ sessionId, agentId }: SkillLoop) => {
  const sessionDir = join(mimirHome(), "agents", "skills", safeId(sessionId));
  return agentId === undefined
    ? join(sessionDir, "main.json")
    : join(sessionDir, "agents", `${safeId(agentId)}.json`);
};

export const readLoadedSkills = async (loop: SkillLoop) => {
  const path = loadedSkillsPath(loop);
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  // Serialisation boundary: narrowed below before it is trusted.
  const [err, raw] = await attempt(async () => (await file.json()) as unknown);
  if (err)
    throw new Error(
      `Cannot read the loaded skills record ${path}: ${errMessage(err)}`,
    );
  const skills = Array.isArray(raw)
    ? raw.filter((skill) => typeof skill === "string")
    : [];
  if (!Array.isArray(raw) || skills.length !== raw.length)
    throw new Error(
      `Cannot read the loaded skills record ${path}: expected an array of skill names.`,
    );
  return skills;
};

export const recordLoadedSkill = async (loop: SkillLoop, skill: string) => {
  const skills = await readLoadedSkills(loop);
  if (skills.includes(skill)) return;
  await Bun.write(
    loadedSkillsPath(loop),
    `${JSON.stringify([...skills, skill])}\n`,
  );
};
