import type { AppStore } from "../store/state.ts";
import { spawnWorker } from "../workers/spawn.ts";
import type { IoCommand } from "./protocol.ts";

const WORKER_NAME = "io";

/** The single io worker; config and permissions persistence share it. */
export const attachIo = (store: AppStore) => {
  const worker = spawnWorker<IoCommand>(
    WORKER_NAME,
    new URL("./worker.ts", import.meta.url),
    store.dispatch,
  );
  store.listen((action) => {
    if (action.type === "app/quit") {
      worker.terminate();
    }
  });
  return worker;
};

export type IoWorker = ReturnType<typeof attachIo>;
