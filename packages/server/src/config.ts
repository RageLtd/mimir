/** Central configuration — environment variables with sensible defaults */

export const config = {
  /** Mimir server */
  port: parseInt(Bun.env.MIMIR_PORT ?? "8080", 10),
  host: Bun.env.MIMIR_HOST ?? "0.0.0.0",

  /** vLLM on the Spark */
  vllm: {
    baseUrl: Bun.env.VLLM_BASE_URL ?? "http://spark.local:8000",
    model: Bun.env.VLLM_MODEL ?? "Qwen/Qwen3.5-122B-A10B",
  },

  /** Ollama — runs on the Spark */
  ollama: {
    baseUrl: Bun.env.OLLAMA_BASE_URL ?? "http://ollama.spark.lan",
    embedModel: Bun.env.OLLAMA_EMBED_MODEL ?? "qwen3-embedding:0.6b",
  },

  /** LM Studio — OpenAI-compatible server, default port 1234. Only initialized
   *  when LMSTUDIO_BASE_URL is set; models discovered dynamically from /v1/models.
   *  Currently-loaded models in the LM Studio UI are the only ones exposed —
   *  loading or unloading mid-session requires a server restart to refresh. */
  lmstudio: {
    baseUrl: Bun.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234",
  },

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

  /** Provider/model metadata source (models.dev shape). Fetched into memory
   *  at boot and refreshed on a TTL — no disk artifact (MIM-65). */
  providerData: {
    url: Bun.env.PROVIDER_DATA_URL ?? "https://models.dev/api.json",
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

  /** Small model — used for memory extraction, summarization, and utility requests
   *  (title generation, etc.) that shouldn't hit the main inference model. */
  smallModel: {
    /** OpenAI-compatible API endpoint */
    baseUrl:
      Bun.env.SMALL_MODEL_BASE_URL ??
      Bun.env.ZEN_BASE_URL ??
      "https://opencode.ai/zen/v1",
    /** API key for the endpoint */
    apiKey: Bun.env.SMALL_MODEL_API_KEY ?? Bun.env.OPENCODE_API_KEY ?? "",
    /** Model identifier */
    model: Bun.env.SMALL_MODEL_MODEL ?? "gpt-5-nano",
    /** Provider type for self-hosted: "ollama" | "lmstudio" | "openai". If unset, uses provider registry. */
    providerType: Bun.env.SMALL_MODEL_PROVIDER_TYPE as
      | "ollama"
      | "lmstudio"
      | "openai"
      | undefined,
    /** Manual context window override (uses models.dev lookup if unset) */
    contextWindow: Bun.env.SMALL_MODEL_CONTEXT_WINDOW
      ? parseInt(Bun.env.SMALL_MODEL_CONTEXT_WINDOW, 10)
      : undefined,
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

  /** Bundled server-side integrations — the Context7/Time stdio MCP
   * children spawned at boot and the Tavily-backed web_search tool. On by
   * default so self-hosted keeps today's behaviour; cloud deployments set
   * BUNDLED_TOOLS_ENABLED=false so these don't burn the operator's tokens
   * for every user — clients bring their own MCP servers instead (MIM-76). */
  bundledTools: {
    enabled: Bun.env.BUNDLED_TOOLS_ENABLED !== "false",
  },

  /** Context7 — API key optional (free tier works without) */
  context7: {
    apiKey: Bun.env.CONTEXT7_API_KEY ?? "",
  },

  /** Tavily — API key required for web search */
  tavily: {
    apiKey: Bun.env.TAVILY_API_KEY ?? "",
  },

  /** OpenCode Zen — multi-provider gateway for frontier model escalation */
  zen: {
    apiKey: Bun.env.OPENCODE_API_KEY ?? "",
    baseUrl: Bun.env.ZEN_BASE_URL ?? "https://opencode.ai/zen/v1",
    goBaseUrl: Bun.env.ZEN_GO_BASE_URL ?? "https://opencode.ai/zen/go/v1",
    /**
     * Whether to advertise OpenCode Go (`opencode-go` provider) models in
     * `/v1/models`. Opt-in via `ZEN_GO_ENABLED=true`. Defaults to `false`
     * because Go models share `OPENCODE_API_KEY` with regular Zen models —
     * the registry initialises the Go provider whenever the key is present,
     * but most accounts don't carry a Go subscription, so showing those
     * models in the editor's selector would advertise things the user
     * can't actually invoke. Users with a Go subscription set the env var
     * to surface them.
     */
    goEnabled: (Bun.env.ZEN_GO_ENABLED ?? "false") === "true",
  },

  /** OpenRouter — multi-provider gateway (OpenAI-compatible) */
  openrouter: {
    apiKey: Bun.env.OPENROUTER_API_KEY ?? "",
    /**
     * When true, only advertise models that have at least one ZDR-compliant
     * endpoint, and pass `provider: { zdr: true }` on inference requests so
     * OpenRouter only routes to zero-data-retention providers.
     */
    zdr: (Bun.env.OPENROUTER_ZDR ?? "false") === "true",
    /**
     * When true, only advertise models with zero-cost pricing (both prompt
     * and completion at "0"). Works in conjunction with ZDR — a model must
     * pass both filters when both are enabled.
     */
    freeOnly: (Bun.env.OPENROUTER_FREE ?? "false") === "true",
    /**
     * Comma-separated model ID prefixes to exclude from the model list.
     * Filters out model families whose upstream data retention policies
     * can't be verified, regardless of the provider's ZDR status.
     * e.g. "openai,black-forest-labs,flux" removes all OpenAI and Flux models.
     */
    excludePrefixes: (Bun.env.OPENROUTER_EXCLUDE ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  },

  /** System prompt — loaded from markdown file */
  systemPromptPath: Bun.env.SYSTEM_PROMPT_PATH ?? "./system-prompt.md",
} as const;

/** Fixed external API endpoints */
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";
