/**
 * Runtime config shared by hooks at ~/.mimir/config.json. Written once at
 * install time, read by the rules-hook, reindex-hook, and boot-context
 * paths — anything that needs to know the mimir-server URL, the cartographer
 * binary location, or the user-memory DB path without having to re-prompt
 * the developer.
 *
 * Out-of-band on purpose: separated from mcp.json (CC owns that file) and
 * settings.json (CC owns that file too). Mimir-cc owns config.json
 * exclusively, so we can extend the schema without colliding with CC.
 */

import { join } from "node:path";

import { mimirHome } from "./util";

export type MimirConfig = {
  readonly serverUrl: string;
  readonly userMemoryDb: string;
  /** Absolute path to the cartographer binary. Unset means reindex is disabled. */
  readonly cartographerBinary?: string;
};

const configPath = () => join(mimirHome(), "config.json");

export const writeConfig = async (config: MimirConfig) => {
  await Bun.write(configPath(), `${JSON.stringify(config, null, 2)}\n`);
};

export const readConfig = async (): Promise<MimirConfig | null> => {
  const file = Bun.file(configPath());
  if (!(await file.exists())) return null;
  try {
    const parsed = (await file.json()) as Partial<MimirConfig>;
    if (
      typeof parsed.serverUrl !== "string" ||
      typeof parsed.userMemoryDb !== "string"
    ) {
      return null;
    }
    return {
      serverUrl: parsed.serverUrl,
      userMemoryDb: parsed.userMemoryDb,
      ...(typeof parsed.cartographerBinary === "string"
        ? { cartographerBinary: parsed.cartographerBinary }
        : {}),
    };
  } catch {
    return null;
  }
};
