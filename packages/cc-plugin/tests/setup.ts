/**
 * Preloaded before every Bun test in this package (bunfig.toml). The
 * binary's code resolves its logs, state and config under `mimirHome()`;
 * pointed at a scratch directory, a test run leaves the developer's own
 * `~/.mimir` — its live log above all — untouched.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.MIMIR_HOME = mkdtempSync(join(tmpdir(), "mimir-cc-test-"));
