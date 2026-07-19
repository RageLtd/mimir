import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  OPERATOR_PATH_GLOB,
  OPERATOR_ROOT_PATH,
  OPERATOR_SETTINGS_PATH,
} from "../operator/paths";
import type { IdentityEnv } from "./identity";
import {
  createOperatorBrowserGate,
  createOperatorNavigationEnrichment,
  isOperatorBrowserPath,
} from "./operator-browser";

const OPERATOR_ID = "operator-1";
const CHECK_PATH = `${OPERATOR_ROOT_PATH}/check`;
const SESSION_COOKIE = "session=valid";
const PRIVATE_NO_STORE = "private, no-store";
const SESSION = {
  user: { id: OPERATOR_ID },
  session: {
    activeOrganizationId: "org-ignored",
    createdAt: new Date(),
  },
};

function appWithGrant(grant: (userId: string) => boolean) {
  const app = new Hono<IdentityEnv>();
  app.use(
    OPERATOR_PATH_GLOB,
    createOperatorBrowserGate(() => Promise.resolve(SESSION), grant),
  );
  app.get(CHECK_PATH, (c) =>
    c.text(c.get("operatorIdentity")?.userId ?? "missing"),
  );
  return app;
}

function appWithNavigationGrant(
  grant: (userId: string) => Promise<boolean> | boolean,
) {
  const app = new Hono<IdentityEnv>();
  app.use("/app", async (c, next) => {
    c.set("identity", { userId: OPERATOR_ID, orgId: "org-1" });
    return next();
  });
  app.use("/app", createOperatorNavigationEnrichment(grant));
  app.get("/app", (c) =>
    c.text(c.get("operatorNavigation") === true ? "operator" : "tenant"),
  );
  return app;
}

describe("operator browser boundary", () => {
  test("matches only the exact operator route family", () => {
    expect(isOperatorBrowserPath(OPERATOR_ROOT_PATH)).toBe(true);
    expect(isOperatorBrowserPath(OPERATOR_SETTINGS_PATH)).toBe(true);
    expect(isOperatorBrowserPath("/operatorium")).toBe(false);
  });

  test("requires a Better Auth browser cookie and redirects signed-out navigation", async () => {
    const response = await appWithGrant(() => true).request(CHECK_PATH);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("/sign-in");
    expect(response.headers.get("cache-control")).toBe(PRIVATE_NO_STORE);
  });

  test("sets only instance operator identity after a live grant lookup", async () => {
    let lookedUp = "";
    const response = await appWithGrant((userId) => {
      lookedUp = userId;
      return true;
    }).request(CHECK_PATH, { headers: { cookie: SESSION_COOKIE } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(OPERATOR_ID);
    expect(lookedUp).toBe(OPERATOR_ID);
  });

  test("denies organization identities without an instance grant", async () => {
    const response = await appWithGrant(() => false).request(CHECK_PATH, {
      headers: { cookie: SESSION_COOKIE },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Forbidden");
  });

  test("rejects API keys and bearer credentials even beside a valid cookie", async () => {
    const app = appWithGrant(() => true);
    for (const headers of [
      new Headers({
        cookie: SESSION_COOKIE,
        authorization: "Bearer operator-secret",
      }),
      new Headers({ cookie: SESSION_COOKIE, "x-api-key": "tenant-key" }),
    ]) {
      const response = await app.request(CHECK_PATH, { headers });
      expect(response.status).toBe(403);
    }
  });

  test("takes grant revocation effect on the next request", async () => {
    let granted = true;
    const app = appWithGrant(() => granted);
    expect(
      (
        await app.request(CHECK_PATH, {
          headers: { cookie: SESSION_COOKIE },
        })
      ).status,
    ).toBe(200);
    granted = false;
    expect(
      (
        await app.request(CHECK_PATH, {
          headers: { cookie: SESSION_COOKIE },
        })
      ).status,
    ).toBe(403);
  });

  test("enriches navigation only after a live browser grant lookup", async () => {
    const granted = await appWithNavigationGrant(() => true).request("/app", {
      headers: { cookie: SESSION_COOKIE },
    });
    const denied = await appWithNavigationGrant(() => false).request("/app", {
      headers: { cookie: SESSION_COOKIE },
    });

    expect(await granted.text()).toBe("operator");
    expect(await denied.text()).toBe("tenant");
  });

  test("navigation enrichment fails closed on lookup errors and machine credentials", async () => {
    const failed = await appWithNavigationGrant(() =>
      Promise.reject(new Error("lookup failed")),
    ).request("/app", { headers: { cookie: SESSION_COOKIE } });
    const machine = await appWithNavigationGrant(() => true).request("/app", {
      headers: {
        cookie: SESSION_COOKIE,
        authorization: "Bearer machine-key",
      },
    });

    expect(await failed.text()).toBe("tenant");
    expect(await machine.text()).toBe("tenant");
  });
});
