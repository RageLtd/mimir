import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { attempt } from "@mimir/plugin-core/result";

const GIT_DIR = ".git";

/** Nearest ancestor holding `.git` (dir or worktree file); `cwd` if none. */
export const findProjectRoot = async (cwd: string) => {
  let current = cwd;
  while (true) {
    const [error] = await attempt(() => stat(join(current, GIT_DIR)));
    if (error === null) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return cwd;
    }
    current = parent;
  }
};
