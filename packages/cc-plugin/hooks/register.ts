/**
 * Mimir's Claude Code hooks module — the in-process half of the plugin.
 *
 * One file per concern, each exporting a `Register`; this entry only wires
 * them. The brain stays in the mimir-cc binary (see binary.ts): this
 * module runs in the engine's sandbox and reaches everything else
 * through `$`.
 *
 * `claude plugin validate .` reads this module the way the engine will;
 * `claude plugin test .` runs the `*.test.ts` beside it. hooks.json names
 * this file alone: no command hooks remain.
 */

import type { Register } from "claude-code";
import { registerBoot } from "./boot";
import { registerEditGuard } from "./edit-guard";
import { registerFileContext } from "./file-context";
import { registerGate } from "./gate";
import { registerLifecycle } from "./lifecycle";
import { registerPersona } from "./persona";
import { registerReindex } from "./reindex";
import { registerSessionEnd } from "./session-end";
import { registerSubmit } from "./submit";

export const register: Register = (on, options) => {
  registerPersona(on, options);
  registerLifecycle(on, options);
  registerSessionEnd(on, options);
  registerBoot(on, options);
  registerSubmit(on, options);
  // The edit guard is pure and goes first: a shell edit is refused before
  // the gate pays two binary runs for it.
  registerEditGuard(on, options);
  registerGate(on, options);
  registerFileContext(on, options);
  registerReindex(on, options);
};
