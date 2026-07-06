import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Surreal } from "surrealdb";

// requestScope is the slice-5 activation switch: mint a scoped JWT session
// only when the bridge secret is configured AND an identity was resolved;
// otherwise fall back to the shared root connection (the auth-off homelab
// path, byte-identical to before). Mock the connection + mint seam so no real
// SurrealDB is touched; a mutable config holder toggles the secret per test.

const authConfig: { surrealAccessSecret?: string } = {};
mock.module("../config", () => ({ config: { auth: authConfig } }));

const rootDb = new Surreal();
const scopedDb = new Surreal();
const getDb = mock(() => Promise.resolve(rootDb));
const connectScoped = mock(() => Promise.resolve(scopedDb));
mock.module("./surreal", () => ({ getDb, connectScoped }));

const mintSurrealToken = mock(() => "signed.jwt.token");
mock.module("../auth/surreal-bridge", () => ({ mintSurrealToken }));

const { requestScope } = await import("./build-scope");

const IDENTITY = { userId: "user-1", orgId: "org-a" };

describe("requestScope", () => {
  beforeEach(() => {
    authConfig.surrealAccessSecret = undefined;
    getDb.mockClear();
    connectScoped.mockClear();
    mintSurrealToken.mockClear();
  });

  test("no secret → root connection on the fallback org (no JWT minted)", async () => {
    const scope = await requestScope(IDENTITY, "owner");
    expect(scope.isRoot).toBe(true);
    expect(scope.orgId).toBe("owner");
    expect(scope.db).toBe(rootDb);
    expect(connectScoped).not.toHaveBeenCalled();
    expect(mintSurrealToken).not.toHaveBeenCalled();
  });

  test("secret + identity → scoped JWT session on the identity's org", async () => {
    authConfig.surrealAccessSecret = "bridge-secret";
    const scope = await requestScope(IDENTITY, "owner");
    expect(scope.isRoot).toBe(false);
    expect(scope.orgId).toBe("org-a");
    expect(scope.db).toBe(scopedDb);
    expect(mintSurrealToken).toHaveBeenCalledWith({
      userId: "user-1",
      orgId: "org-a",
    });
  });

  test("secret but no identity → root fallback (gate resolved nothing)", async () => {
    authConfig.surrealAccessSecret = "bridge-secret";
    const scope = await requestScope(undefined, "owner");
    expect(scope.isRoot).toBe(true);
    expect(scope.orgId).toBe("owner");
    expect(connectScoped).not.toHaveBeenCalled();
  });
});
