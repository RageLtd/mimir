import { Hono } from "hono";
import { cors } from "hono/cors";
import { createClaimGuard, SIGNUP_PATH } from "./auth/claim";
import { getAuth } from "./auth/instance";
import { config } from "./config";
import { getTenantDb } from "./db/tenant";
import { createIdentityGate, type IdentityEnv } from "./middleware/identity";
import { keys } from "./routes/keys";
import { mcp } from "./routes/mcp";
import { projects } from "./routes/projects";
import { sync } from "./routes/sync";
import { systemPrompt } from "./routes/system-prompt";
import { log } from "./util/logger";
import { attemptSync } from "./util/result";
import { web } from "./web";

interface AppOptions {
  authEnabled?: boolean;
}

export function createApp(options: AppOptions = {}) {
  const app = new Hono<IdentityEnv>();
  const authEnabled = options.authEnabled ?? config.auth.enabled;

  app.use("*", cors());

  // Better Auth (MIM-70) — the ONLY gating mechanism. Mount order matters:
  // the claim guard wraps the signup endpoint, the auth handler self-gates
  // its own routes, and the identity gate covers everything else (with
  // /health exempt). Lazy getAuth(): an auth-disabled app never constructs
  // the instance or touches the SQLite file.
  if (authEnabled) {
    app.use(SIGNUP_PATH, createClaimGuard());
    app.on(["POST", "GET"], "/api/auth/*", (c) => getAuth().handler(c.req.raw));
    app.use("*", createIdentityGate());
    log.info("better-auth identity gate active");
  } else {
    log.warn(
      "AUTH_ENABLED=false — API is UNAUTHENTICATED; enable auth before exposing this server publicly",
    );
  }

  type HealthStatus = { status: string; latency?: string; error?: string };

  app.get("/health", (c) => {
    const start = Date.now();
    const [err] = attemptSync(() => getTenantDb().query("SELECT 1").get());
    const store: HealthStatus = err
      ? { status: "down", error: err.message }
      : { status: "ok", latency: `${Date.now() - start}ms` };
    const status = err ? "degraded" : "ok";
    return c.json(
      { status, version: "0.3.0", services: { tenantStore: store } },
      err ? 503 : 200,
    );
  });

  app.route("/v1/system-prompt", systemPrompt);
  app.route("/v1/projects", projects);
  app.route("/v1/keys", keys);
  app.route("/v1/sync", sync);
  app.route("/mcp", mcp);
  app.route("/", web);

  return app;
}
