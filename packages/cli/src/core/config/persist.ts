import type { IoWorker } from "../io/bridge.ts";
import type { AppStore } from "../store/state.ts";

/**
 * Loads the config file at startup and writes it back after every runtime
 * edit. Persistence stays suspended while `status` is `error` so a malformed
 * file on disk is never overwritten with defaults.
 */
export const attachConfigPersistence = (store: AppStore, io: IoWorker) => {
  io.post({ type: "io/load-config" });
  store.subscribe(
    (state) => state.config.config,
    () => {
      const { status, dirty, config } = store.getState().config;
      if (status === "ready" && dirty) {
        io.post({ type: "io/save-config", config });
      }
    },
  );
};
