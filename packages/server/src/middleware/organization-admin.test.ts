import { describe, expect, test } from "bun:test";
import {
  canManageOrganization,
  readOrganizationMembership,
} from "./organization-admin";

const identity = { userId: "user-1", orgId: "org-1" };

describe("organization membership validation", () => {
  test("accepts a matching active member and normalizes one or many roles", () => {
    expect(
      readOrganizationMembership(
        { userId: "user-1", organizationId: "org-1", role: "owner" },
        identity,
      ),
    ).toEqual({ ...identity, organizationRoles: ["owner"] });
    expect(
      readOrganizationMembership(
        {
          userId: "user-1",
          organizationId: "org-1",
          role: ["member", "admin"],
        },
        identity,
      ),
    ).toEqual({ ...identity, organizationRoles: ["member", "admin"] });
  });

  test("fails closed on malformed, wrong-user, and wrong-organization records", () => {
    expect(readOrganizationMembership(null, identity)).toBeNull();
    expect(
      readOrganizationMembership(
        { userId: "other", organizationId: "org-1", role: "owner" },
        identity,
      ),
    ).toBeNull();
    expect(
      readOrganizationMembership(
        { userId: "user-1", organizationId: "other", role: "owner" },
        identity,
      ),
    ).toBeNull();
    expect(
      readOrganizationMembership(
        { userId: "user-1", organizationId: "org-1", role: [] },
        identity,
      ),
    ).toBeNull();
  });

  test("only owner or admin roles authorize organization management", () => {
    expect(
      canManageOrganization({ ...identity, organizationRoles: ["owner"] }),
    ).toBe(true);
    expect(
      canManageOrganization({
        ...identity,
        organizationRoles: ["member", "admin"],
      }),
    ).toBe(true);
    expect(
      canManageOrganization({ ...identity, organizationRoles: ["member"] }),
    ).toBe(false);
    expect(canManageOrganization(identity)).toBe(false);
  });
});
