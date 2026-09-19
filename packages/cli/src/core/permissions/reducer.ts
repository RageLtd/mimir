import type { Action } from "../store/actions.ts";
import type { AppStore } from "../store/state.ts";
import {
  type AllowRule,
  type PermissionRequest,
  ruleFor,
  sameRule,
} from "./rules.ts";

export type PermissionsState = {
  /** Requests awaiting the user, oldest first; the UI shows `pending[0]`. */
  pending: PermissionRequest[];
  rules: AllowRule[];
  /** Same semantics as ConfigState.status: `error` suspends persistence. */
  status: "loading" | "ready" | "error";
  dirty: boolean;
};

export const INITIAL_PERMISSIONS: PermissionsState = {
  pending: [],
  rules: [],
  status: "loading",
  dirty: false,
};

const without = (pending: PermissionRequest[], id: string) =>
  pending.filter((request) => request.id !== id);

export const permissionsReducer = (state: PermissionsState, action: Action) => {
  switch (action.type) {
    case "permission/requested":
      return { ...state, pending: [...state.pending, action.request] };
    case "permission/cancelled":
      return { ...state, pending: without(state.pending, action.id) };
    case "permission/answered": {
      const request = state.pending.find((r) => r.id === action.id);
      const next = { ...state, pending: without(state.pending, action.id) };
      if (request === undefined || action.decision !== "allow-always") {
        return next;
      }
      const rule = ruleFor(request);
      if (rule === undefined || state.rules.some((r) => sameRule(r, rule))) {
        return next;
      }
      return { ...next, rules: [...state.rules, rule], dirty: true };
    }
    case "permissions/loaded":
      return {
        ...state,
        status: "ready" as const,
        rules: action.rules,
        dirty: false,
      };
    case "permissions/load-failed":
      return { ...state, status: "error" as const, dirty: false };
    case "permissions/saved":
      return state.dirty ? { ...state, dirty: false } : state;
    default:
      return state;
  }
};

export const registerPermissionsSlice = (store: AppStore) => {
  store.register("permissions", INITIAL_PERMISSIONS, permissionsReducer);
};
