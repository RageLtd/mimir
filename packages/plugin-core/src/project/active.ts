/**
 * The project a host is working in, or null. Every host resolves its
 * project id the same way: read the config (or take the one it already
 * holds), resolve through it, and treat a failed resolution as "no
 * project" rather than an error — attribution is best-effort and must
 * never fail a hook.
 */

import type { Logger } from "../logger";
import { type MimirConfig, readConfig } from "../shared-config";
import { errMessage } from "../util";
import { getOrResolveProjectId } from "./index";

const DEFAULT_FAILURE_MESSAGE = "project id resolve failed";

export type ActiveProjectOptions = {
  /** Config to resolve through in place of reading `config.json`. */
  readonly config?: Pick<MimirConfig, "serverUrl" | "apiKey">;
  /** Where a failed resolution is logged; omitted means silent. */
  readonly log?: Logger;
  /** The failure line's level, message and leading fields; the error's
   *  message is always appended as `error`. */
  readonly failure?: {
    readonly level?: "debug" | "warn";
    readonly message?: string;
    readonly context?: Readonly<Record<string, unknown>>;
  };
  readonly resolve?: typeof getOrResolveProjectId;
};

export const activeProjectId = async (
  dir: string,
  opts: ActiveProjectOptions = {},
) => {
  const config = opts.config ?? (await readConfig());
  if (!config) return null;
  const resolve = opts.resolve ?? getOrResolveProjectId;
  return resolve(config.serverUrl, dir, config.apiKey).catch((err) => {
    const failure = opts.failure ?? {};
    opts.log?.[failure.level ?? "warn"](
      failure.message ?? DEFAULT_FAILURE_MESSAGE,
      { ...failure.context, error: errMessage(err) },
    );
    return null;
  });
};
