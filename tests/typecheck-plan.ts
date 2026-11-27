/**
 * What a typecheck run does, decided apart from running it: which
 * packages, and what becomes of the cc-plugin hooks-module leg.
 *
 * That leg types against declarations the Claude Code engine writes into
 * `.claude-plugin/types/` — only on an interactive load of the plugin,
 * and the folder ignores itself in git. A plain run skips the leg where
 * they are absent, so a fresh clone and CI still pass. The worker verify
 * gate passes `--require-mod-types` (mimir.toml) and fails instead: a
 * gate that skipped would pass a hooks-module change nobody type-checked.
 */

export const REQUIRE_MOD_TYPES_FLAG = "--require-mod-types";
export const MOD_TSCONFIG = "packages/cc-plugin/hooks/tsconfig.json";
export const MOD_TYPES_TSCONFIG =
  "packages/cc-plugin/.claude-plugin/types/tsconfig.json";

const MOD_PACKAGE = "cc-plugin";
const LOAD_COMMAND = "claude --plugin-dir packages/cc-plugin";

export const PACKAGES: readonly string[] = [
  "server",
  "plugin-core",
  MOD_PACKAGE,
  "oc-plugin",
  "codex-plugin",
];

export type ModLeg =
  | { readonly kind: "not-considered" }
  | { readonly kind: "run" }
  | { readonly kind: "skip"; readonly note: string }
  | { readonly kind: "fail"; readonly message: string };

export const isPackage = (name: string) => PACKAGES.includes(name);

/** The arguments after the script's name: an optional filter and the flag, in either order. */
export const parseArgs = (argv: readonly string[]) => ({
  filter: argv.find((arg) => arg !== REQUIRE_MOD_TYPES_FLAG),
  requireModTypes: argv.includes(REQUIRE_MOD_TYPES_FLAG),
});

/**
 * A name that isn't a package (the verify gate passes `basename $PWD`,
 * which is the repo name at the root) means the whole workspace.
 */
export const packagesToRun = (filter: string | undefined) =>
  filter !== undefined && isPackage(filter) ? [filter] : PACKAGES;

export const modLeg = (input: {
  readonly filter: string | undefined;
  readonly typesPresent: boolean;
  readonly requireModTypes: boolean;
}) => {
  const narrowedElsewhere =
    input.filter !== undefined &&
    isPackage(input.filter) &&
    input.filter !== MOD_PACKAGE;
  if (narrowedElsewhere) return { kind: "not-considered" } satisfies ModLeg;
  if (input.typesPresent) return { kind: "run" } satisfies ModLeg;
  if (input.requireModTypes) {
    return {
      kind: "fail",
      message: `${MOD_TYPES_TSCONFIG} absent, and ${REQUIRE_MOD_TYPES_FLAG} requires the hooks module to be type-checked. The engine lays these declarations when the plugin is loaded interactively: run \`${LOAD_COMMAND}\` once in the main checkout (a headless \`-p\` run does not lay them). A worker worktree gets them from the worktree bootstrap, which copies them from the coordinator's tree.`,
    } satisfies ModLeg;
  }
  return {
    kind: "skip",
    note: `skipped: ${MOD_TYPES_TSCONFIG} absent — run \`${LOAD_COMMAND}\` once, interactively, to lay the engine's types`,
  } satisfies ModLeg;
};
