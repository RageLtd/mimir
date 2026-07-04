import { Hono } from "hono";
import { cors } from "hono/cors";
import { clearStaleCompaction } from "./agent/message-log";
import {
  initProviderRegistry,
  loadProviderData,
  startProviderDataRefresh,
  stopProviderDataRefresh,
} from "./agent/provider";
import { closeMcpClients, initMcpTools } from "./agent/server-tools/mcp";
import { config, OPENROUTER_API_URL } from "./config";
import { closeDb, getDb, initSchema } from "./db/surreal";
import {
  startHygieneScheduler,
  stopHygieneScheduler,
} from "./goldfish/hygiene";
import { createBearerGate } from "./middleware/auth";
import { cartographer } from "./routes/cartographer";
import { completions } from "./routes/completions";
import { context } from "./routes/context";
import { hygiene } from "./routes/hygiene";
import { mcp } from "./routes/mcp";
import { messages } from "./routes/messages";
import { messagesIngress } from "./routes/messages-ingress";
import { models as modelsRoute } from "./routes/models";
import { projects } from "./routes/projects";
import { systemPrompt } from "./routes/system-prompt";
import { tools } from "./routes/tools";
import { log } from "./util/logger";
import { attempt } from "./util/result";

const app = new Hono();

// Middleware
app.use("*", cors());

// Interim API-key gate (MIM-77) — mounted only when keys are configured.
// /health stays open for credential-less healthchecks. Empty key set is
// the self-hosted default and warns loudly rather than failing boot.
if (config.auth.keys.length > 0) {
  app.use("*", createBearerGate(config.auth.keys));
  log.info({ keys: config.auth.keys.length }, "API-key gate active");
} else {
  log.warn(
    "MIMIR_API_KEYS unset — API is UNAUTHENTICATED; set keys before exposing this server publicly",
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
  const healthChecks = [
    (async (): Promise<[string, HealthStatus]> => {
      const start = Date.now();
      const [err] = await attempt(async () => {
        const db = await getDb();
        await db.query("RETURN true");
      });
      return [
        "surrealdb",
        err
          ? { status: "down", error: err.message }
          : { status: "ok", latency: `${Date.now() - start}ms` },
      ];
    })(),
    pingService(`${config.ollama.baseUrl}/api/tags`).then(
      (r) => ["ollama", r] as [string, HealthStatus],
    ),
    pingService(`${config.vllm.baseUrl}/health`).then(
      (r) => ["vllm", r] as [string, HealthStatus],
    ),
  ];

  // Only check LM Studio if explicitly configured — opt-in local provider,
  // not always running on every user's machine.
  if (Bun.env.LMSTUDIO_BASE_URL) {
    healthChecks.push(
      pingService(`${config.lmstudio.baseUrl}/v1/models`).then(
        (r) => ["lmstudio", r] as [string, HealthStatus],
      ),
    );
  }

  // Only check Zen if configured
  if (config.zen.apiKey) {
    healthChecks.push(
      pingService(`${config.zen.baseUrl}/models`).then(
        (r) => ["zen", r] as [string, HealthStatus],
      ),
    );
  }

  // Only check OpenRouter if configured
  if (config.openrouter.apiKey) {
    healthChecks.push(
      pingService(`${OPENROUTER_API_URL}/models`).then(
        (r) => ["openrouter", r] as [string, HealthStatus],
      ),
    );
  }

  const results = await Promise.all(healthChecks);
  const checks = Object.fromEntries(results);
  const allUp = Object.values(checks).every(
    (c) => (c as HealthStatus).status === "ok",
  );
  const criticalDown =
    (checks.surrealdb as HealthStatus)?.status === "down" ||
    (checks.vllm as HealthStatus)?.status === "down";
  const status = allUp ? "ok" : criticalDown ? "degraded" : "partial";

  return c.json(
    { status, version: "0.3.0", services: checks },
    status === "ok" ? 200 : 503,
  );
});

// OpenAI-compatible API (primary interface)
app.route("/", completions);
app.route("/", modelsRoute);

// Context provider API (for CC backend and external consumers)
app.route("/v1/system-prompt", systemPrompt);
app.route("/v1/context", context);
app.route("/v1/messages", messages);
app.route("/v1/messages", messagesIngress);

// Cartographer and tools
app.route("/v1/cartographer", cartographer);
app.route("/v1/tools", tools);

// Project registry
app.route("/v1/projects", projects);

// Memory hygiene — manual sweep trigger
app.route("/v1/hygiene", hygiene);

// MCP server for Claude Code tool injection
app.route("/mcp", mcp);

// Boot sequence
let server: ReturnType<typeof Bun.serve> | null = null;

async function boot() {
  log.info("starting server");

  const [dbErr] = await attempt(initSchema);
  if (dbErr) {
    log.error({ err: dbErr }, "failed to connect to SurrealDB");
    log.warn("continuing without database — some features will be unavailable");
  } else {
    log.info("SurrealDB connected");
    // Recover from crashes mid-compaction — a stuck is_compacting lock
    // permanently blocks all future compactions
    await clearStaleCompaction();
  }

  // Provider metadata (models.dev) — in-memory with TTL refresh (MIM-65).
  // Non-fatal: a failed fetch means remote providers sit out until the
  // retry loop lands; local providers register regardless.
  const providerDataLoaded = await loadProviderData();
  if (!providerDataLoaded) {
    log.warn(
      "provider data unavailable — remote providers disabled until refresh",
    );
  }

  // Initialize provider registry (models from endpoints + in-memory provider data)
  const [registryErr] = await attempt(initProviderRegistry);
  if (registryErr) {
    log.warn(
      { err: registryErr },
      "model registry init failed — using vLLM fallback only",
    );
  }

  // Keep provider data warm: 24h TTL, 15min retry while empty. Re-runs the
  // registry init after each successful load (registration is additive).
  startProviderDataRefresh(initProviderRegistry);

  // Connect to external MCP servers (non-fatal). No name-set refresh
  // needed — tool classification reads ctx.serverTools, which picks up
  // MCP tools from getServerTools() on every request.
  const [mcpErr] = await attempt(initMcpTools);
  if (mcpErr) {
    log.warn(
      { err: mcpErr },
      "MCP tools init failed — docs lookup unavailable",
    );
  }

  server = Bun.serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
    idleTimeout: 0, // disabled — long-running requests (Ollama cold starts,
    // vLLM long generations, multi-merge hygiene sweeps) own their own
    // duration; a fixed idle ceiling here is our limit to impose, not Bun's.
  });

  log.info(
    {
      host: server.hostname,
      port: server.port,
      vllm: config.vllm.baseUrl,
      model: config.vllm.model,
      zen: config.zen.apiKey ? config.zen.baseUrl : "not configured",
      openrouter: config.openrouter.apiKey ? "configured" : "not configured",
    },
    "listening",
  );

  // Periodic memory hygiene sweep (clears its own stale lock on start).
  const [hygieneErr] = await attempt(startHygieneScheduler);
  if (hygieneErr) {
    log.warn({ err: hygieneErr }, "hygiene scheduler failed to start");
  }
}

// Graceful shutdown
async function shutdown(signal: string) {
  log.info({ signal }, "shutdown requested");

  stopHygieneScheduler();
  stopProviderDataRefresh();

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

  // Close MCP clients
  await closeMcpClients();

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

boot();
