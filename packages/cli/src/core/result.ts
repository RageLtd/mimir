import type { Result } from "@mimir/plugin-core/result";

export { attempt, attemptSync } from "@mimir/plugin-core/result";
export type { Result };

/** Constructors for plugin-core's Go-style `[error, data]` tuples. */
export const ok = <T>(data: T) => [null, data] as Result<T>;
export const fail = <T = never>(message: string) =>
  [new Error(message), null] as Result<T>;

export const assertNever = (value: never) => {
  throw new Error(`unhandled variant: ${JSON.stringify(value)}`);
};
