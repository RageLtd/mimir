/**
 * The binary this plugin runs is the one released with it.
 *
 * A plugin and its `mimir-cc` binary ship under one tag, and the two
 * speak a private protocol that changes between releases: a module ahead
 * of its binary calls subcommands the binary lacks, and one behind it is
 * answered in a shape it does not read. So at every session start the
 * module (lifecycle.ts) asks the `ensure-binary.sh` it ships for the
 * binary of its own version. Already installed is a local file check;
 * otherwise the script downloads that release and moves it into place. A
 * dev build pinned by dev-install.sh is left alone by the script.
 *
 * Pure helpers only: the session-start hook spells the `$` calls itself.
 */

const MANIFEST = ".claude-plugin/plugin.json";
const ENSURE_BINARY = "scripts/ensure-binary.sh";
const FLAVOR = "cc";
const VERSION = /^\d+\.\d+\.\d+$/;

/** A release binary over a slow link; nothing waits on it. */
export const FETCH_TIMEOUT_MS = 180_000;

export const manifestPath = (root: string) => `${root}/${MANIFEST}`;

/** The manifest's version, or undefined when it is not one. */
export const manifestVersion = (manifest: string) => {
  // Serialisation boundary: the plugin's own plugin.json.
  const { version } = JSON.parse(manifest) as { version?: unknown };
  return typeof version === "string" && VERSION.test(version)
    ? version
    : undefined;
};

/** `argv` for `$.process.run`: the plugin's own script, for one release. */
export const pinArgv = (root: string, version: string) => [
  "/bin/sh",
  `${root}/${ENSURE_BINARY}`,
  FLAVOR,
  version,
];
