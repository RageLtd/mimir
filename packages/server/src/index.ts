import { Hono } from "hono";
import { cors } from "hono/cors";
import { countUsers, createClaimGuard, SIGNUP_PATH } from "./auth/claim";
import { getAuth, getAuthDb, runAuthMigrations } from "./auth/instance";
import { config } from "./config";
import { closeDb, getDb, initSchema } from "./db/surreal";
import { createIdentityGate, type IdentityEnv } from "./middleware/identity";
import { keys } from "./routes/keys";
import { mcp } from "./routes/mcp";
import { projects } from "./routes/projects";
import { systemPrompt } from "./routes/system-prompt";
import { log } from "./util/logger";
import { attempt, attemptSync } from "./util/result";

const app = new Hono<IdentityEnv>();

// Middleware
app.use("*", cors());

// Better Auth (MIM-70) — the ONLY gating mechanism. Mount order matters:
// the claim guard wraps the signup endpoint, the auth handler self-gates
// its own routes, and the identity gate covers everything else (with
// /health exempt). Lazy getAuth(): an auth-disabled boot never constructs
// the instance or touches the SQLite file.
if (config.auth.enabled) {
  app.use(SIGNUP_PATH, createClaimGuard());
  app.on(["POST", "GET"], "/api/auth/*", (c) => getAuth().handler(c.req.raw));
  app.use("*", createIdentityGate());
  log.info("better-auth identity gate active");
} else {
  log.warn(
    "AUTH_ENABLED=false — API is UNAUTHENTICATED; enable auth before exposing this server publicly",
  );
}

// Rich health check — pings all backend services in parallel
type HealthStatus = { status: string; latency?: string; error?: string };

async function pingService(url: string): Promise<HealthStatus> {
  const start = Date.now();
  const [err] = await attempt(() =>
    fetch(url, { signal: AbortSignal.timeout(5_000) }).then((r) => {
      if (!r.ok) throw new Error(`${r.status}`);
    }),
  );
  return err
    ? { status: "down", error: err.message }
    : { status: "ok", latency: `${Date.now() - start}ms` };
}

app.get("/health", async (c) => {
  // Post-MIM-89 the server runs no inference — provider pings left with
  // it. Surreal is the critical dependency; the embedding endpoint feeds
  // /mcp memory retrieval and degrades the answer quality, not the server.
  const healthChecks = [
    (async () => {
      const start = Date.now();
      const [err] = await attempt(async () => {
        const db = await getDb();
        await db.query("RETURN true");
      });
      const entry: [string, HealthStatus] = [
        "surrealdb",
        err
          ? { status: "down", error: err.message }
          : { status: "ok", latency: `${Date.now() - start}ms` },
      ];
      return entry;
    })(),
  ];

  // Only the OpenAI-compatible embedding path has a pingable base URL;
  // the Cohere path is a hosted API with its own availability story.
  if (config.embedding.type === "openai") {
    healthChecks.push(
      pingService(`${config.embedding.baseUrl}/api/tags`).then(
        (r) => ["embedding", r] as [string, HealthStatus],
      ),
    );
  }

  const results = await Promise.all(healthChecks);
  const checks = Object.fromEntries(results);
  const allUp = Object.values(checks).every(
    (c) => (c as HealthStatus).status === "ok",
  );
  const criticalDown = (checks.surrealdb as HealthStatus)?.status === "down";
  const status = allUp ? "ok" : criticalDown ? "degraded" : "partial";

  return c.json(
    { status, version: "0.3.0", services: checks },
    status === "ok" ? 200 : 503,
  );
});

// System prompt (cc-plugin install + ACP boot fetch)
app.route("/v1/system-prompt", systemPrompt);

// Project registry
app.route("/v1/projects", projects);

// Wrapped-key distribution (MIM-87) — ciphertext relay only
app.route("/v1/keys", keys);

// MCP server for Claude Code tool injection
app.route("/mcp", mcp);

// Boot sequence
let server: ReturnType<typeof Bun.serve> | null = null;

async function boot() {
  log.info("starting server");

  // Fatal by design: a server without its database is a zombie — every
  // DB-backed route fails while the process looks healthy. Crashing the
  // boot instead makes the deploy fail loudly (Railway keeps the previous
  // deployment serving) rather than shipping a brainless instance. Runtime
  // blips are NOT affected — getDb reconnects per request and fails fast
  // via the SURREAL_TIMEOUT_MS deadline (MIM-79).
  const [dbErr] = await attempt(initSchema);
  if (dbErr) {
    log.fatal({ err: dbErr }, "failed to connect to SurrealDB — aborting boot");
    process.exit(1);
  }
  log.info("SurrealDB connected");

  // Better Auth (MIM-70) — fatal by the same zombie logic as the DB above:
  // an auth-enabled server whose auth layer can't initialise would 401
  // every request while looking healthy. AUTH_SECRET has no default; a
  // defaulted secret would be a backdoor, so its absence aborts here.
  if (config.auth.enabled) {
    if (!config.auth.secret) {
      log.fatal(
        "AUTH_ENABLED is set but AUTH_SECRET is missing — aborting boot",
      );
      process.exit(1);
    }
    const [authErr] = await attempt(runAuthMigrations);
    if (authErr) {
      log.fatal(
        { err: authErr },
        "better-auth migrations failed — aborting boot",
      );
      process.exit(1);
    }
    log.info({ db: config.auth.dbPath }, "auth layer enabled (better-auth)");

    // First-boot claim state (MIM-70 slice 2): announce loudly so the
    // operator knows whether the instance is claimable — and whether the
    // claim is even possible without a setup token.
    if (countUsers(getAuthDb()) === 0) {
      if (config.auth.setupToken) {
        log.warn(
          "instance is UNCLAIMED — first sign-up with a valid X-Setup-Token claims it",
        );
      } else {
        log.warn(
          "instance is UNCLAIMED and AUTH_SETUP_TOKEN is unset — sign-up is impossible until a setup token is configured",
        );
      }
    }
  }

  // No provider registry, no MCP children — the inference path and its
  // tooling live client-side since MIM-89. What boots here is exactly
  // what the reduced server serves: auth, projects, /mcp, system prompt.

  // Fatal by the same zombie logic as the DB above — a server that boots
  // but never listens is the quietest zombie of all (MIM-80). Without this
  // guard the bind failure fell into the unhandledRejection net below and
  // the process lingered, healthy-looking, serving nothing. Crashing makes
  // Railway keep the previous deployment live instead.
  const [serveErr, bound] = attemptSync(() =>
    Bun.serve({
      fetch: app.fetch,
      port: config.port,
      hostname: config.host,
      idleTimeout: 0, // disabled — long-running requests (Ollama cold starts,
      // vLLM long generations) own their own duration; a fixed idle ceiling
      // here is our limit to impose, not Bun's.
    }),
  );
  if (serveErr) {
    log.fatal(
      { err: serveErr, host: config.host, port: config.port },
      "failed to bind — aborting boot (is the port already in use?)",
    );
    process.exit(1);
  }
  server = bound;

  log.info(
    {
      host: server.hostname,
      port: server.port,
      embedding: `${config.embedding.type}:${config.embedding.model}`,
    },
    "listening",
  );
}

// Graceful shutdown
async function shutdown(signal: string) {
  log.info({ signal }, "shutdown requested");

  if (server) {
    server.stop(true); // graceful — finishes in-flight requests
    log.info("server stopped accepting new connections");
  }

  const [dbErr] = await attempt(() => closeDb());
  if (dbErr) {
    log.warn({ err: dbErr }, "error closing SurrealDB");
  } else {
    log.info("SurrealDB connection closed");
  }

  log.info("shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Safety net for unhandled rejections from third-party libraries.
// The AI SDK's internal TransformStream pipeline can throw errors
// (e.g. NoOutputGeneratedError) in flush() handlers that are impossible
// to catch with try/catch or promise suppression. Without this handler,
// Bun crashes the process on any unhandled rejection.
process.on("unhandledRejection", (reason) => {
  log.error(
    {
      err:
        reason instanceof Error
          ? { message: reason.message, name: reason.name }
          : reason,
    },
    "unhandled rejection (suppressed)",
  );
});

// boot() is a floating promise — without this catch, ANY throw during the
// boot sequence would land in the unhandledRejection net above and be
// demoted from fatal to a suppressed log line (the MIM-80 failure class).
boot().catch((err) => {
  log.fatal({ err }, "boot failed — aborting");
  process.exit(1);
});
