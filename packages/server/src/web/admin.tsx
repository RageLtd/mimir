import type { Context } from "hono";
import type { IdentityEnv } from "../middleware/identity";
import { dashboardNavigation, PageFrame } from "./chrome";

export function renderOrganizationAdmin(c: Context<IdentityEnv>) {
  c.header("cache-control", "private, no-store");
  return c.redirect("/admin/members");
}

export function renderOrganizationBilling(c: Context<IdentityEnv>) {
  const identity = c.get("identity");
  if (!identity) return c.text("Forbidden", 403);
  c.header("cache-control", "private, no-store");
  return c.render(
    <PageFrame
      actions={<a href="/app">Account</a>}
      navigation={dashboardNavigation(c, "organization-billing")}
    >
      <section
        aria-labelledby="billing-title"
        data-user-id={identity.userId}
        data-organization-id={identity.orgId}
      >
        <p class="kicker">Organization administration</p>
        <h1 id="billing-title">Billing</h1>
        <p class="lede">
          Organization billing is not available yet. No payment provider or
          billing contract has been configured.
        </p>
      </section>
    </PageFrame>,
    {
      title: "Organization billing — Mimir",
      description: "Review billing availability for the active organization.",
      styles: ["dashboard"],
    },
  );
}
