/**
 * Shapes shared by the toolchain resolver and its manifest table. Kept
 * apart so `toolchain-manifests.ts` doesn't import the resolver that
 * imports it.
 */

/** The verify commands a package can expose. All optional. */
export type VerifyCommands = {
  readonly test?: string;
  /** Checks that need no build: formatting, and lints that read source. */
  readonly check?: string;
  readonly typecheck?: string;
  /**
   * Checks that need the code to build, such as `cargo clippy`. Kept apart
   * from `check` because a red test may not compile yet.
   */
  readonly vet?: string;
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
