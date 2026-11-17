/**
 * Renders the `/delegate` coordinator command for a worker host: the shared
 * policy (delegate-policy.ts) woven through that host's mechanics.
 */

import type { WorkerHost } from "../shared-config";
import { CLAUDE_CODE_DELEGATE } from "./delegate-claude-code";
import { OPENCODE_DELEGATE } from "./delegate-opencode";
import { DELEGATE_DESCRIPTION } from "./delegate-policy";

export { DELEGATE_POLICY } from "./delegate-policy";

const FENCE = "---";

const assertNever = (value: never) => {
  throw new Error(`Unhandled worker host: ${String(value)}`);
};

const hostDelegate = (host: WorkerHost) => {
  switch (host) {
    case "claudeCode":
      return CLAUDE_CODE_DELEGATE;
    case "opencode":
      return OPENCODE_DELEGATE;
    default:
      return assertNever(host);
  }
};

export const renderDelegateCommand = (host: WorkerHost) => {
  const { frontmatter, body } = hostDelegate(host);
  return [
    FENCE,
    `description: ${DELEGATE_DESCRIPTION}`,
    ...frontmatter,
    FENCE,
    "",
    body,
    "",
    "$ARGUMENTS",
    "",
  ].join("\n");
};
