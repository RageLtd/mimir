import type { IoWorker } from "../io/bridge.ts";
import type { AppStore } from "../store/state.ts";

/** Same contract as config persistence: load once, save on dirty && ready. */
export const attachPermissionsPersistence = (store: AppStore, io: IoWorker) => {
  io.post({ type: "io/load-permissions" });
  store.subscribe(
    (state) => state.permissions.rules,
    () => {
      const { status, dirty, rules } = store.getState().permissions;
      if (status === "ready" && dirty) {
        io.post({ type: "io/save-permissions", rules });
      }
    },
  );
};
