/**
 * The bridge from the hooks module to the mimir-cc binary.
 *
 * The module runs in the engine's sandbox — no Node, no Bun, no bare
 * imports — so everything that touches sqlite, the embedder or the
 * cartographer stays in `~/.local/bin/mimir-cc`. Each leg is a subcommand
 * that reads a hook payload on stdin and answers with the same JSON the
 * command-hook contract uses.
 *
 * These helpers are pure on purpose: `claude plugin validate` follows `$`
 * only within one file, so a hook spells `$.process.run(argv, init)`
 * itself and this file only shapes the call and reads the answer.
 */

export const MIMIR_CC_BINARY = ".local/bin/mimir-cc";

/** The subset of a command hook's stdout JSON the module acts on. */
export type HookOutput = {
  readonly hookSpecificOutput?: {
    readonly additionalContext?: string;
  };
  readonly systemMessage?: string;
  /** persist / precompact: whether the delta they were handed is settled. */
  readonly advance?: boolean;
};

/** `argv` for `$.process.run`: the installed binary and one subcommand. */
export const mimirCcArgv = (home: string, subcommand: string) => [
  `${home}/${MIMIR_CC_BINARY}`,
  subcommand,
];

/** `init` for `$.process.run`: the payload (if any) on stdin, gates passed. */
export const mimirCcInit = (payload: unknown, timeoutMs: number) => ({
  env: { MIMIR_ACTIVE: "1" },
  timeoutMs,
  ...(payload === undefined ? {} : { stdin: JSON.stringify(payload) }),
});

export const parseHookOutput = (stdout: string) => {
  if (stdout.trim().length === 0) return {};
  // Serialisation boundary: the binary's stdout is JSON of a known shape.
  return JSON.parse(stdout) as HookOutput;
};
