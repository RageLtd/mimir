/** Central configuration — environment variables with sensible defaults */

export const config = {
  /** Mimir server */
  port: parseInt(Bun.env.MIMIR_PORT ?? "8080", 10),
  host: Bun.env.MIMIR_HOST ?? "0.0.0.0",

  /** Embedding client.
   *  type "openai" (default): any OpenAI-compatible endpoint via baseUrl —
   *  the self-hosted Ollama path. type "cohere": Cohere's NATIVE /v2/embed
   *  API (goldfish/embed-cohere.ts) — chosen for cloud because it supports
   *  output_dimension (the OpenAI-compat shim doesn't), so both paths emit
   *  1024-dim vectors and the HNSW schema never changes between them. */
  embedding: {
    /** Client type. EMBED_TYPE=cohere → native Cohere v2 API. */
    type: Bun.env.EMBED_TYPE === "cohere" ? "cohere" : "openai",
    /** OpenAI-compatible API endpoint (type "openai" only) */
    baseUrl:
      Bun.env.EMBED_BASE_URL ??
      Bun.env.OLLAMA_BASE_URL ??
      "http://ollama.spark.lan",
    /** API key (empty for local Ollama; required for Cohere) */
    apiKey: Bun.env.EMBED_API_KEY ?? "",
    /** Model identifier */
    model:
      Bun.env.EMBED_MODEL ??
      Bun.env.OLLAMA_EMBED_MODEL ??
      "qwen3-embedding:0.6b",
    /** Vector dimensions the model emits — MUST match the HNSW index
     *  (initSchema interpolates this). Changing it on a populated memory
     *  table requires re-embedding the corpus (scripts/reembed-import.ts);
     *  the boot-time dimension check refuses to silently mismatch. */
    dimensions: parseInt(Bun.env.EMBED_DIMENSIONS ?? "1024", 10),
  },

  /** MIM-70 Better Auth layer — the only gating mechanism (the MIM-77
   *  static MIMIR_API_KEYS gate is retired). */
  auth: {
    /** Disabled by default — the self-hosted path runs ungated with a loud
     *  boot warning. Enabling requires AUTH_SECRET; boot fails loudly
     *  without. */
    enabled: (Bun.env.AUTH_ENABLED ?? "false") === "true",
    /** SQLite store path. Railway sets this onto the mounted volume
     *  (e.g. /data/auth.sqlite); local default stays cwd-relative so a
     *  dev boot never needs a /data mount. */
    dbPath: Bun.env.AUTH_DB_PATH ?? "./auth.sqlite",
    /** better-auth signing/encryption secret — required when enabled,
     *  no default on purpose (a defaulted secret is a backdoor). */
    secret: Bun.env.AUTH_SECRET ?? "",
    /** Public base URL of this server — feeds better-auth's baseURL and
     *  the passkey plugin's rpID derivation. */
    baseUrl:
      Bun.env.AUTH_BASE_URL ??
      `http://localhost:${Bun.env.MIMIR_PORT ?? "8080"}`,
    /** One-time first-boot claim token (MIM-70 slice 2): while zero users
     *  exist, sign-up succeeds only when X-Setup-Token matches this. */
    setupToken: Bun.env.AUTH_SETUP_TOKEN ?? "",
    /** Shared HS256 secret for the Surreal record-access bridge (MIM-70
     *  slice 4). When set, initSchema defines the mimir_user JWT access
     *  method and scoped sessions become mintable; unset → bridge dormant.
     *  No default on purpose, same backdoor logic as AUTH_SECRET. */
    surrealAccessSecret: Bun.env.SURREAL_ACCESS_SECRET ?? "",
  },

  /** SurrealDB */
  surreal: {
    url: Bun.env.SURREAL_URL ?? "http://surrealdb:8000/rpc",
    namespace: Bun.env.SURREAL_NS ?? "mimir",
    database: Bun.env.SURREAL_DB ?? "mimir",
    user: Bun.env.SURREAL_USER ?? "root",
    pass: Bun.env.SURREAL_PASS ?? "root",
    /** Deadline for the connect handshake and the liveness probe, in ms.
     *  The SDK's ConnectOptions has no timeout of its own (v2.0.3), so a
     *  refused/hanging upstream otherwise stalls requests for 60s+ at the
     *  transport layer (observed on Railway, MIM-79). */
    timeoutMs: parseInt(Bun.env.SURREAL_TIMEOUT_MS ?? "10000", 10),
  },

  /** Bundled server-side integrations — the Tavily-backed web_search tool
   * exposed over /mcp. On by default so self-hosted keeps today's
   * behaviour; cloud deployments set BUNDLED_TOOLS_ENABLED=false so it
   * doesn't burn the operator's tokens for every user (MIM-76). The
   * Context7/Time stdio MCP children died with the agent loop (MIM-89) —
   * they were loop-only tools, never exposed over /mcp. */
  bundledTools: {
    enabled: Bun.env.BUNDLED_TOOLS_ENABLED !== "false",
  },

  /** Tavily — API key required for web search */
  tavily: {
    apiKey: Bun.env.TAVILY_API_KEY ?? "",
  },

  /** System prompt — loaded from markdown file */
  systemPromptPath: Bun.env.SYSTEM_PROMPT_PATH ?? "./system-prompt.md",
} as const;
