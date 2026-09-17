/**
 * Loop guard — how many times the gate has blocked one worker. After
 * `MAX_BLOCKS` the gate lets the worker stop with `STATUS: failed`
 * appended, so the coordinator escalates instead of the worker grinding.
 *
 * State lives beside the coordinator state under `~/.mimir/agents/`.
 */

import { join } from "node:path";
import { attempt } from "../result";
import { asRecord } from "../toml";
import { mimirHome } from "../util";

export const MAX_BLOCKS = 3;

const statePath = (agentId: string) =>
  join(
    mimirHome(),
    "agents",
    `verify-${agentId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`,
  );

export const readBlocks = async (agentId: string) => {
  const file = Bun.file(statePath(agentId));
  if (!(await file.exists())) return 0;
  const [err, raw] = await attempt(async () => (await file.json()) as unknown);
  const blocks = err ? null : asRecord(raw)?.blocks;
  return typeof blocks === "number" && blocks >= 0 ? blocks : 0;
};

/** Record one more block; returns the new count. */
export const noteBlock = async (agentId: string) => {
  const blocks = (await readBlocks(agentId)) + 1;
  await Bun.write(statePath(agentId), `${JSON.stringify({ blocks })}\n`);
  return blocks;
};

export const clearBlocks = async (agentId: string) => {
  const file = Bun.file(statePath(agentId));
  if (await file.exists()) await file.delete();
};
