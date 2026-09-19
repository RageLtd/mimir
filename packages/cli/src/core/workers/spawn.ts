import type { Action } from "../store/actions.ts";

/**
 * Spawns a Bun worker whose messages are `Action`s: everything it posts is
 * dispatched straight into the store. Commands go the other way via `post`.
 */
export const spawnWorker = <Command>(
  name: string,
  url: URL,
  dispatch: (action: Action) => void,
) => {
  const worker = new Worker(url);
  worker.addEventListener("message", (event: MessageEvent<Action>) => {
    dispatch(event.data);
  });
  worker.addEventListener("error", (event: ErrorEvent) => {
    dispatch({ type: "worker/error", worker: name, message: event.message });
  });
  return {
    post: (command: Command) => worker.postMessage(command),
    terminate: () => worker.terminate(),
  };
};
