/**
 * The rules Mimir ships: its own coding opinions, as rule files that an
 * install or update writes under the Mimir home. Every host then loads
 * them from there, ahead of the project's own rules.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { mimirRulesDir } from "./project-rules";
import callingCodeFirst from "./shipped/calling-code-first.md" with {
  type: "text",
};
import dataForTheLoop from "./shipped/data-for-the-loop.md" with {
  type: "text",
};
import layersAndDependencies from "./shipped/layers-and-dependencies.md" with {
  type: "text",
};
import noNeedlessWork from "./shipped/no-needless-work.md" with {
  type: "text",
};
import operationOverType from "./shipped/operation-over-type.md" with {
  type: "text",
};
import reachableStatesOnly from "./shipped/reachable-states-only.md" with {
  type: "text",
};

/** File name to the rule's whole text, in the order every host reads them. */
export const SHIPPED_RULES: Readonly<Record<string, string>> = {
  "calling-code-first.md": callingCodeFirst,
  "data-for-the-loop.md": dataForTheLoop,
  "layers-and-dependencies.md": layersAndDependencies,
  "no-needless-work.md": noNeedlessWork,
  "operation-over-type.md": operationOverType,
  "reachable-states-only.md": reachableStatesOnly,
};

/** Overwrites the installed copies, so an update replaces a rule the user edited. */
export const writeShippedRules = async () => {
  const dir = mimirRulesDir();
  await mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(SHIPPED_RULES)) {
    await Bun.write(join(dir, name), text);
  }
};
