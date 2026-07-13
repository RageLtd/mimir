import { describe, expect, test } from "bun:test";
import { createApp } from "../app";

const app = createApp({
  authEnabled: true,
  authHandler: async () => Response.json({}),
  claimGuard: async (_c, next) => next(),
  sessionLookup: async (headers) =>
    headers.get("cookie") === "session=valid"
      ? {
          user: { id: "user-1" },
          session: { activeOrganizationId: "org-1" },
        }
      : null,
  orgLister: async () => [],
});

describe("encrypted memories page", () => {
  test("is protected by the browser route boundary", async () => {
    const response = await app.request("/app/memories");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/sign-in?returnTo=%2Fapp%2Fmemories",
    );
  });

  test("renders only an identity-scoped locked shell", async () => {
    const response = await app.request("/app/memories", {
      headers: { cookie: "session=valid" },
    });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toContain("mimir-memory-manager");
    expect(body).toContain('data-user-id="user-1"');
    expect(body).toContain('data-org-id="org-1"');
    expect(body).toContain('/assets/memories.js');
    expect(body).toContain("No memory plaintext has been requested");
    expect(body).not.toContain("private canary memory");
  });
});
