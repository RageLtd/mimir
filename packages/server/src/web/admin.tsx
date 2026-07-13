import type { Context } from "hono";
import type { IdentityEnv } from "../middleware/identity";
import { DashboardNavigation, PageFrame } from "./chrome";

export function renderOrganizationAdmin(c: Context<IdentityEnv>) {
  const identity = c.get("identity");
  const role = identity?.organizationRoles?.find(
    (candidate) => candidate === "owner" || candidate === "admin",
  );
  c.header("cache-control", "private, no-store");
  return c.render(
    <PageFrame
      actions={<a href="/app">Dashboard</a>}
      navigation={
        <DashboardNavigation current="admin" organizationAdmin={true} />
      }
    >
      <section
        aria-labelledby="admin-title"
        data-user-id={identity?.userId}
        data-organization-id={identity?.orgId}
        data-organization-role={role}
      >
        <p class="kicker">Organization administration</p>
        <h1 id="admin-title">Manage this organization</h1>
        <p class="lede">
          Organization settings and membership stay scoped to the active
          organization. Server operation is a separate authority.
        </p>
        <div class="cards">
          <section class="card" aria-labelledby="members-title">
            <h2 id="members-title">Members &amp; invitations</h2>
            <p>Manage organization access and organization-scoped roles.</p>
          </section>
          <section class="card" aria-labelledby="settings-title">
            <h2 id="settings-title">Organization settings</h2>
            <p>Configure settings owned by this organization.</p>
          </section>
          <section class="card" aria-labelledby="billing-title">
            <h2 id="billing-title">Billing</h2>
            <p>Review organization billing when it becomes available.</p>
          </section>
          <section class="card" aria-labelledby="operations-title">
            <h2 id="operations-title">Operations</h2>
            <p>Review permitted organization-level operational metadata.</p>
          </section>
        </div>
      </section>
    </PageFrame>,
    {
      title: "Organization administration — Mimir",
      description: "Manage the active Mimir organization.",
    },
  );
}
