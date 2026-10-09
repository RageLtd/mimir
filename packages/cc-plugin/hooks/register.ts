/**
 * Mimir's Claude Code hooks module — the in-process half of the plugin.
 *
 * One file per event, each exporting a `Register`; this entry only wires
 * them. The brain stays in the mimir-cc binary (see binary.ts): this
 * module runs in the engine's sandbox and reaches everything else
 * through `$`.
 *
 * `claude plugin validate .` reads this module the way the engine will;
 * `claude plugin test .` runs the `*.test.ts` beside it.
 */

import type { Register } from "claude-code";
import { registerBoot } from "./boot";
import { registerPersona } from "./persona";
import { registerSubmit } from "./submit";

export const register: Register = (on, options) => {
  registerPersona(on, options);
  registerBoot(on, options);
  registerSubmit(on, options);
};
