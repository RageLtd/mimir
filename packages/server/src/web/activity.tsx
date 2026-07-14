import type { Context } from "hono";
import {
  type createOrganizationAuditStore,
  ORGANIZATION_AUDIT_ACTIONS,
  ORGANIZATION_AUDIT_OUTCOMES,
  ORGANIZATION_AUDIT_TARGETS,
  type OrganizationAuditFilters,
} from "../audit/store";
import type { IdentityEnv } from "../middleware/identity";
import { attemptSync } from "../util/result";
import { DashboardNavigation, PageFrame } from "./chrome";

export type OrganizationAuditList = ReturnType<
  typeof createOrganizationAuditStore
>["list"];

interface ActivityQuery {
  action?: string;
  actor?: string;
  target?: string;
  outcome?: string;
  from?: string;
  cursor?: string;
}

const OPAQUE_ID = /^[A-Za-z0-9:_-]{1,200}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,32}$/;

function matchingValue<T extends string>(values: readonly T[], value: string) {
  return values.find((candidate) => candidate === value);
}

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value
  );
}

export function parseActivityFilters(query: ActivityQuery) {
  const action = query.action
    ? matchingValue(ORGANIZATION_AUDIT_ACTIONS, query.action)
    : undefined;
  const targetType = query.target
    ? matchingValue(ORGANIZATION_AUDIT_TARGETS, query.target)
    : undefined;
  const outcome = query.outcome
    ? matchingValue(ORGANIZATION_AUDIT_OUTCOMES, query.outcome)
    : undefined;
  if (
    (query.action && !action) ||
    (query.target && !targetType) ||
    (query.outcome && !outcome) ||
    (query.actor && !OPAQUE_ID.test(query.actor)) ||
    (query.from && !validDate(query.from)) ||
    (query.cursor && !CURSOR.test(query.cursor))
  ) {
    return null;
  }
  return {
    ...(action ? { action } : {}),
    ...(query.actor ? { actorUserId: query.actor } : {}),
    ...(targetType ? { targetType } : {}),
    ...(outcome ? { outcome } : {}),
    ...(query.from ? { fromDate: query.from } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
    limit: 25,
  } satisfies OrganizationAuditFilters;
}

function metadataRows(metadata: {
  count?: number;
  field?: string;
  fromRole?: string;
  toRole?: string;
  generation?: number;
  reasonCode?: string;
  retentionDays?: number;
}) {
  return [
    metadata.count === undefined ? null : ["Count", String(metadata.count)],
    metadata.field ? ["Field", metadata.field] : null,
    metadata.fromRole ? ["Previous role", metadata.fromRole] : null,
    metadata.toRole ? ["New role", metadata.toRole] : null,
    metadata.generation === undefined
      ? null
      : ["Key generation", String(metadata.generation)],
    metadata.reasonCode ? ["Reason", metadata.reasonCode] : null,
    metadata.retentionDays === undefined
      ? null
      : ["Retention days", String(metadata.retentionDays)],
  ].flatMap((row) => (row ? [row] : []));
}

function nextPageHref(filters: OrganizationAuditFilters, cursor: string) {
  const params = new URLSearchParams();
  if (filters.action) params.set("action", filters.action);
  if (filters.actorUserId) params.set("actor", filters.actorUserId);
  if (filters.targetType) params.set("target", filters.targetType);
  if (filters.outcome) params.set("outcome", filters.outcome);
  if (filters.fromDate) params.set("from", filters.fromDate);
  params.set("cursor", cursor);
  return `/admin/activity?${params}`;
}

export function renderOrganizationActivity(
  c: Context<IdentityEnv>,
  list: OrganizationAuditList,
) {
  const identity = c.get("identity");
  if (!identity) return c.text("Forbidden", 403);
  const filters = parseActivityFilters({
    action: c.req.query("action"),
    actor: c.req.query("actor"),
    target: c.req.query("target"),
    outcome: c.req.query("outcome"),
    from: c.req.query("from"),
    cursor: c.req.query("cursor"),
  });
  if (!filters) return c.text("Bad request", 400);
  const [error, result] = attemptSync(() => list(identity.orgId, filters));
  if (error) return c.text("Unavailable", 503);

  c.header("cache-control", "private, no-store");
  return c.render(
    <PageFrame
      actions={<a href="/admin">Organization</a>}
      navigation={
        <DashboardNavigation current="admin" organizationAdmin={true} />
      }
    >
      <section aria-labelledby="activity-title">
        <p class="kicker">Organization administration</p>
        <h1 id="activity-title">Activity</h1>
        <p class="lede">
          Security-sensitive organization changes retained for{" "}
          {result.retentionDays} days. This record is server-held metadata, not
          a cryptographic transparency log.
        </p>

        <form class="audit-filters" method="get" action="/admin/activity">
          <label for="audit-action">Action</label>
          <select id="audit-action" name="action">
            <option value="">All actions</option>
            {ORGANIZATION_AUDIT_ACTIONS.map((action) => (
              <option value={action} selected={filters.action === action}>
                {action}
              </option>
            ))}
          </select>
          <label for="audit-actor">Actor ID</label>
          <input
            id="audit-actor"
            name="actor"
            value={filters.actorUserId}
            maxlength={200}
            autocomplete="off"
          />
          <label for="audit-target">Target</label>
          <select id="audit-target" name="target">
            <option value="">All targets</option>
            {ORGANIZATION_AUDIT_TARGETS.map((target) => (
              <option value={target} selected={filters.targetType === target}>
                {target}
              </option>
            ))}
          </select>
          <label for="audit-outcome">Outcome</label>
          <select id="audit-outcome" name="outcome">
            <option value="">All outcomes</option>
            {ORGANIZATION_AUDIT_OUTCOMES.map((outcome) => (
              <option value={outcome} selected={filters.outcome === outcome}>
                {outcome}
              </option>
            ))}
          </select>
          <label for="audit-from">From</label>
          <input
            id="audit-from"
            name="from"
            type="date"
            value={filters.fromDate}
          />
          <button type="submit">Filter</button>
        </form>

        {result.events.length === 0 ? (
          <p class="notice">No matching organization activity.</p>
        ) : (
          <ol class="items audit-events">
            {result.events.map((event) => {
              const details = metadataRows(event.metadata);
              return (
                <li class="item">
                  <div class="item-head">
                    <strong>{event.action}</strong>
                    <time datetime={event.createdAt}>{event.createdAt}</time>
                  </div>
                  <dl class="status">
                    <dt>Outcome</dt>
                    <dd>{event.outcome}</dd>
                    <dt>Actor</dt>
                    <dd class="secret">{event.actorUserId}</dd>
                    <dt>Target</dt>
                    <dd class="secret">
                      {event.targetType}:{event.targetId}
                    </dd>
                    <dt>Request</dt>
                    <dd class="secret">{event.requestId}</dd>
                    {details.map(([label, value]) => (
                      <>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </>
                    ))}
                  </dl>
                </li>
              );
            })}
          </ol>
        )}

        {result.nextCursor ? (
          <p>
            <a href={nextPageHref(filters, result.nextCursor)}>
              Older activity
            </a>
          </p>
        ) : null}
      </section>
    </PageFrame>,
    {
      title: "Organization activity — Mimir",
      description: "Review security-sensitive organization changes.",
    },
  );
}
