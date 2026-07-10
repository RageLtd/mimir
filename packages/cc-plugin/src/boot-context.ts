/**
 * Re-export shim — boot-context assembly moved to plugin-core
 * (@mimir/plugin-core/brain/boot-context) when codex-plugin became its
 * second hook-based consumer. This shim binds cc-plugin's logger so
 * boot lines keep landing in mimir-cc.log.
 */

import {
  assembleBootContext as assembleShared,
  type BootContextOptions as SharedOptions,
} from "@mimir/plugin-core/brain/boot-context";
import { createLogger } from "./logger";

const log = createLogger("boot-context");

export type BootContextOptions = Omit<SharedOptions, "log">;

export const assembleBootContext = (opts: BootContextOptions) =>
  assembleShared({ ...opts, log });
