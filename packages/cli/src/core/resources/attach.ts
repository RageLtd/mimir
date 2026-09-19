import type { IoWorker } from "../io/bridge.ts";
import type { AppStore } from "../store/state.ts";

/** Kicks off resource discovery for `cwd`; the io worker answers with `resources/loaded`. */
export const attachResources = (
  _store: AppStore,
  io: IoWorker,
  cwd: string,
) => {
  io.post({ type: "io/load-resources", cwd });
};
