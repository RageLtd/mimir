/**
 * Shapes shared by the toolchain resolver and its manifest table. Kept
 * apart so `toolchain-manifests.ts` doesn't import the resolver that
 * imports it.
 */

/** The three verify commands a package can expose. All optional. */
export type VerifyCommands = {
  readonly test?: string;
  readonly check?: string;
  readonly typecheck?: string;
};

/** Where the commands came from, in resolution order. */
export type ToolchainSource = "config" | "task-runner" | "manifest";

export type ResolvedToolchain = {
  /** Package root the commands run in. */
  readonly root: string;
  readonly source: ToolchainSource;
  /** The file that decided it, e.g. `.mimir/config.toml`, `mise.toml`, `Cargo.toml`. */
  readonly detail: string;
  readonly commands: VerifyCommands;
};
