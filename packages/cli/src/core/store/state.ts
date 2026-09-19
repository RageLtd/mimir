import type { ConfigState } from "../config/reducer.ts";
import type { PermissionsState } from "../permissions/reducer.ts";
import type { ResourcesState } from "../resources/reducer.ts";
import type { TranscriptState } from "../transcript/reducer.ts";
import type { Store } from "./store.ts";

/** Adding a slice: add its state type here and call its `register*` in app. */
export type AppState = {
  config: ConfigState;
  permissions: PermissionsState;
  resources: ResourcesState;
  transcript: TranscriptState;
};

export type AppStore = Store<AppState>;
