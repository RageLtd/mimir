/**
 * Process execution for the verify gate — one shape for git plumbing
 * and toolchain commands, injectable so the pipeline is testable
 * without spawning anything.
 */

export type CommandResult = {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the process was killed for exceeding `timeoutMs`. */
  readonly timedOut: boolean;
};

export type CommandRunner = (
  argv: readonly string[],
  cwd: string,
  timeoutMs?: number,
) => Promise<CommandResult>;

/** Spawn argv in cwd; never throws — a spawn failure is a non-zero code. */
export const runCommand: CommandRunner = async (argv, cwd, timeoutMs) => {
  const proc = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer =
    timeoutMs === undefined
      ? null
      : setTimeout(() => {
          timedOut = true;
          proc.kill();
        }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (timer) clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
};

/** Run a shell command string (toolchain commands are strings). */
export const shellArgv = (command: string) => ["sh", "-c", command];

/** The last `n` non-empty lines of combined output, for a deny reason. */
export const tailLines = (result: CommandResult, n: number) => {
  const lines = `${result.stdout}\n${result.stderr}`
    .split("\n")
    .filter((line) => line.trim().length > 0);
  return lines.slice(-n).join("\n");
};
