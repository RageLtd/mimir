import type { Context } from "hono";
import type { OrganizationRole } from "../auth/membership";
import type {
  CreateInvitationInput,
  InvitationMutationInput,
  listOrganizationMembers,
  MemberReadiness,
  OrganizationMemberFilters,
} from "../auth/organization-members";
import type { IdentityEnv } from "../middleware/identity";
import { attemptSync } from "../util/result";
import { DashboardNavigation, PageFrame } from "./chrome";

export interface OrganizationMembersOptions {
  origin: string;
  list: (
    orgId: string,
    filters: OrganizationMemberFilters,
  ) => ReturnType<typeof listOrganizationMembers>;
  invite: (input: CreateInvitationInput, headers: Headers) => Promise<string>;
  revokeInvitation: (
    input: InvitationMutationInput,
    headers: Headers,
  ) => Promise<string>;
  reissueInvitation: (
    input: InvitationMutationInput,
    headers: Headers,
  ) => Promise<string>;
  request: (path: string, init: RequestInit) => Response | Promise<Response>;
  now?: () => number;
}

interface MemberPageState {
  error?: boolean;
}

const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const MAX_QUERY_LENGTH = 100;
const ORGANIZATION_ROLES: readonly OrganizationRole[] = [
  "owner",
  "admin",
  "member",
];
const ADMIN_ROLES: readonly OrganizationRole[] = ["admin", "member"];
const READINESS_VALUES: readonly MemberReadiness[] = [
  "ready",
  "pending",
  "unregistered",
];
const INVITATION_STATUSES: readonly ("pending" | "expired")[] = [
  "pending",
  "expired",
];

function matching<T extends string>(value: string, values: readonly T[]) {
  return values.find((candidate) => candidate === value);
}

function filters(c: Context<IdentityEnv>) {
  const query = c.req.query("q")?.trim() ?? "";
  const role = matching(c.req.query("role") ?? "", ORGANIZATION_ROLES);
  const readiness = matching(c.req.query("readiness") ?? "", READINESS_VALUES);
  const invitationStatus = matching(
    c.req.query("invitationStatus") ?? "",
    INVITATION_STATUSES,
  );
  const memberCursor = c.req.query("memberCursor") ?? "";
  const invitationCursor = c.req.query("invitationCursor") ?? "";
  if (
    query.length > MAX_QUERY_LENGTH ||
    (c.req.query("role") && !role) ||
    (c.req.query("readiness") && !readiness) ||
    (c.req.query("invitationStatus") && !invitationStatus) ||
    (memberCursor && !CURSOR.test(memberCursor)) ||
    (invitationCursor && !CURSOR.test(invitationCursor))
  ) {
    return null;
  }
  return {
    ...(query ? { query } : {}),
    ...(role ? { role } : {}),
    ...(readiness ? { readiness } : {}),
    ...(invitationStatus ? { invitationStatus } : {}),
    ...(memberCursor ? { memberCursor } : {}),
    ...(invitationCursor ? { invitationCursor } : {}),
  } satisfies OrganizationMemberFilters;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unknown" : date.toLocaleString("en");
}

function readinessLabel(value: MemberReadiness) {
  if (value === "ready") return "Key access available";
  if (value === "pending") return "Pending key access";
  return "Browser key not registered";
}

function noticeText(value: string | undefined) {
  if (value === "invited") return "Invitation created.";
  if (value === "invitation-revoked") return "Invitation revoked.";
  if (value === "invitation-reissued") return "Invitation safely reissued.";
  if (value === "role") return "Organization role updated.";
  if (value === "removed") {
    return "Member removed after rotating future encryption access.";
  }
  return "";
}

function pageHref(
  current: OrganizationMemberFilters,
  next: { memberCursor?: string; invitationCursor?: string },
) {
  const params = new URLSearchParams();
  if (current.query) params.set("q", current.query);
  if (current.role) params.set("role", current.role);
  if (current.readiness) params.set("readiness", current.readiness);
  if (current.invitationStatus) {
    params.set("invitationStatus", current.invitationStatus);
  }
  if (next.memberCursor) params.set("memberCursor", next.memberCursor);
  if (next.invitationCursor) {
    params.set("invitationCursor", next.invitationCursor);
  }
  return `/admin/members?${params}`;
}

function roleOptions(actorRole: OrganizationRole) {
  return actorRole === "owner" ? ORGANIZATION_ROLES : ADMIN_ROLES;
}

export function renderOrganizationMembers(
  c: Context<IdentityEnv>,
  options: OrganizationMembersOptions,
  state: MemberPageState = {},
) {
  const identity = c.get("identity");
  if (!identity) return c.text("Forbidden", 403);
  const parsed = filters(c);
  if (!parsed) return c.text("Bad request", 400);
  const [error, result] = attemptSync(() =>
    options.list(identity.orgId, parsed),
  );
  if (error || !result) return c.text("Unavailable", 503);
  const actorRole: OrganizationRole = identity.organizationRoles?.includes(
    "owner",
  )
    ? "owner"
    : "admin";
  const availableRoles = roleOptions(actorRole);
  const notice = noticeText(c.req.query("notice"));
  c.header("cache-control", "private, no-store");
  c.status(state.error ? 400 : 200);
  return c.render(
    <PageFrame
      actions={<a href="/admin">Organization</a>}
      navigation={
        <DashboardNavigation current="admin" organizationAdmin={true} />
      }
    >
      <section
        aria-labelledby="members-title"
        data-user-id={identity.userId}
        data-organization-id={identity.orgId}
      >
        <p class="kicker">Organization administration</p>
        <h1 id="members-title">Members &amp; invitations</h1>
        <p class="lede">
          Membership grants server access. Decryption begins only after a keyed
          administrator supplies an organization wrap.
        </p>
        {notice ? (
          <p class="notice" role="status">
            {notice}
          </p>
        ) : null}
        {state.error ? (
          <p class="form-error" role="alert">
            The organization change could not be completed.
          </p>
        ) : null}

        <form class="audit-filters" method="get" action="/admin/members">
          <label for="member-query">Search</label>
          <input
            id="member-query"
            name="q"
            value={parsed.query}
            maxlength={MAX_QUERY_LENGTH}
          />
          <label for="member-role">Role</label>
          <select id="member-role" name="role">
            <option value="">All roles</option>
            {ORGANIZATION_ROLES.map((value) => (
              <option value={value} selected={parsed.role === value}>
                {value}
              </option>
            ))}
          </select>
          <label for="member-readiness">Key readiness</label>
          <select id="member-readiness" name="readiness">
            <option value="">All states</option>
            <option value="ready" selected={parsed.readiness === "ready"}>
              Key access available
            </option>
            <option value="pending" selected={parsed.readiness === "pending"}>
              Pending key access
            </option>
            <option
              value="unregistered"
              selected={parsed.readiness === "unregistered"}
            >
              Browser key not registered
            </option>
          </select>
          <label for="invitation-status">Invitation status</label>
          <select id="invitation-status" name="invitationStatus">
            <option value="">Pending and expired</option>
            <option
              value="pending"
              selected={parsed.invitationStatus === "pending"}
            >
              Pending
            </option>
            <option
              value="expired"
              selected={parsed.invitationStatus === "expired"}
            >
              Expired
            </option>
          </select>
          <button type="submit">Filter</button>
        </form>

        <div class="cards">
          <section class="card" aria-labelledby="invite-title">
            <h2 id="invite-title">Invite a member</h2>
            <form class="stack" method="post" action="/admin/members/invite">
              <label for="invite-email">Email</label>
              <input
                id="invite-email"
                name="email"
                type="email"
                autocomplete="off"
                maxlength={320}
                required
              />
              <label for="invite-role">Role</label>
              <select id="invite-role" name="role">
                {availableRoles.map((value) => (
                  <option value={value}>{value}</option>
                ))}
              </select>
              <button class="button" type="submit">
                Create invitation
              </button>
            </form>
          </section>

          <section class="card" aria-labelledby="key-status-title">
            <h2 id="key-status-title">Encryption access</h2>
            <p>
              Current organization generation:{" "}
              {result.keyGeneration ?? "Not initialized"}
            </p>
            <mimir-member-key-manager data-user-id={identity.userId}>
              <button class="button" type="button" data-action="provision">
                Provision pending key access
              </button>
              <p role="status" aria-live="polite">
                Key operations run locally after passkey confirmation.
              </p>
              <noscript>
                <p>Key provisioning and safe removal require JavaScript.</p>
              </noscript>
            </mimir-member-key-manager>
          </section>

          <section class="card wide" aria-labelledby="active-members-title">
            <h2 id="active-members-title">Active members</h2>
            {result.members.length === 0 ? (
              <p class="notice">No matching members.</p>
            ) : (
              <mimir-member-key-manager data-user-id={identity.userId}>
                <ul class="items">
                  {result.members.map((member) => {
                    const canManage =
                      actorRole === "owner" || member.role !== "owner";
                    return (
                      <li class="item">
                        <div class="item-head">
                          <strong>{member.name}</strong>
                          <span>{member.role}</span>
                        </div>
                        <p>{member.email}</p>
                        <dl class="status">
                          <dt>Joined</dt>
                          <dd>{formatDate(member.joinedAt)}</dd>
                          <dt>Public key</dt>
                          <dd>
                            {member.publicKeyRegistered
                              ? "Registered"
                              : "Missing"}
                          </dd>
                          <dt>Organization wrap</dt>
                          <dd>
                            {member.wrapAvailable ? "Available" : "Pending"}
                          </dd>
                          <dt>Security status</dt>
                          <dd>{readinessLabel(member.readiness)}</dd>
                        </dl>
                        {canManage ? (
                          <>
                            <form method="post" action="/admin/members/role">
                              <input
                                type="hidden"
                                name="memberId"
                                value={member.id}
                              />
                              <label>
                                Role{" "}
                                <select name="role">
                                  {availableRoles.map((value) => (
                                    <option
                                      value={value}
                                      selected={member.role === value}
                                    >
                                      {value}
                                    </option>
                                  ))}
                                </select>
                              </label>{" "}
                              <button type="submit">Change role</button>
                            </form>
                            <details>
                              <summary>Remove {member.name}</summary>
                              <p>
                                This rotates future encryption access before
                                removing membership. It cannot erase old keys or
                                plaintext already held by this member.
                              </p>
                              <button
                                type="button"
                                data-action="remove"
                                data-member-id={member.id}
                              >
                                Confirm rotation-backed removal
                              </button>
                            </details>
                          </>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
                <p role="status" aria-live="polite" />
              </mimir-member-key-manager>
            )}
            {result.nextMemberCursor ? (
              <p>
                <a
                  href={pageHref(parsed, {
                    memberCursor: result.nextMemberCursor,
                    invitationCursor: parsed.invitationCursor,
                  })}
                >
                  More members
                </a>
              </p>
            ) : null}
          </section>

          <section class="card wide" aria-labelledby="invitations-title">
            <h2 id="invitations-title">Pending invitations</h2>
            {result.invitations.length === 0 ? (
              <p class="notice">No matching invitations.</p>
            ) : (
              <ul class="items">
                {result.invitations.map((invitation) => {
                  const canManage =
                    actorRole === "owner" || invitation.role !== "owner";
                  return (
                    <li class="item">
                      <div class="item-head">
                        <strong>{invitation.email}</strong>
                        <span>{invitation.status}</span>
                      </div>
                      <p>
                        {invitation.role} · invited by {invitation.inviter} ·
                        created {formatDate(invitation.createdAt)} · expires{" "}
                        {formatDate(invitation.expiresAt)}
                      </p>
                      {canManage ? (
                        <div class="member-actions">
                          <form
                            method="post"
                            action="/admin/members/invitations/reissue"
                          >
                            <input
                              type="hidden"
                              name="email"
                              value={invitation.email}
                            />
                            <button type="submit">Reissue safely</button>
                          </form>
                          <form
                            method="post"
                            action="/admin/members/invitations/revoke"
                          >
                            <input
                              type="hidden"
                              name="email"
                              value={invitation.email}
                            />
                            <button type="submit">Revoke</button>
                          </form>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {result.nextInvitationCursor ? (
              <p>
                <a
                  href={pageHref(parsed, {
                    memberCursor: parsed.memberCursor,
                    invitationCursor: result.nextInvitationCursor,
                  })}
                >
                  More invitations
                </a>
              </p>
            ) : null}
          </section>
        </div>
      </section>
    </PageFrame>,
    {
      title: "Organization members — Mimir",
      description:
        "Manage members and invitations for the active organization.",
      scripts: ["/assets/members.js"],
    },
  );
}
