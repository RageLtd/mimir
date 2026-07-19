import type { Context } from "hono";
import type { Child } from "hono/jsx";
import type { IdentityEnv } from "../middleware/identity";
import {
  type DashboardLocation,
  dashboardNavigation,
  PageFrame,
} from "./chrome";

export interface OperatorPageState {
  error?: boolean;
}

export function operatorErrorMessage(state: OperatorPageState) {
  return state.error ? (
    <p class="form-error" role="alert">
      The change could not be applied.
    </p>
  ) : null;
}

export function operatorNotice(c: Context<IdentityEnv>) {
  const value = c.req.query("notice");
  return value === "setting" ||
    value === "credential" ||
    value === "grant" ||
    value === "revoke" ||
    value === "provision"
    ? value
    : null;
}

export function operatorFrame(
  c: Context<IdentityEnv>,
  current: DashboardLocation,
  children: Child,
) {
  return (
    <PageFrame
      actions={<a href="/app">Account</a>}
      navigation={dashboardNavigation(c, current)}
    >
      {children}
    </PageFrame>
  );
}
