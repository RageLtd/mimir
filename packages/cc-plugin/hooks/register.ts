/**
 * Mimir's Claude Code hooks module — the in-process half of the plugin.
 *
 * One file per concern, each exporting a `Register`; this entry only
 * wires them. The brain stays in the mimir-cc binary (see binary.ts):
 * this module runs in the engine's sandbox and reaches everything else
 * through `$`.
 *
 * `claude plugin validate .` reads this module the way the engine will;
 * `claude plugin test .` runs the `*.test.ts` beside it.
 */

import type { Register } from "claude-code";
import { registerPersona } from "./persona";
import { registerRetrieve } from "./retrieve";

export const register: Register = (on, options) => {
  registerPersona(on, options);
  registerRetrieve(on, options);
};
