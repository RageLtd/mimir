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

  /** Embedding — OpenAI-compatible endpoint (defaults to Ollama for local) */
  embedding: {
    /** OpenAI-compatible API endpoint */
    baseUrl:
      Bun.env.EMBED_BASE_URL ??
      Bun.env.OLLAMA_BASE_URL ??
      "http://ollama.spark.lan",
    /** API key (empty for local Ollama) */
    apiKey: Bun.env.EMBED_API_KEY ?? "",
    /** Model identifier */
    model:
      Bun.env.EMBED_MODEL ??
      Bun.env.OLLAMA_EMBED_MODEL ??
      "qwen3-embedding:0.6b",
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
    apiKey: Bun.env.SMALL_MODEL_API_KEY ?? Bun.env.ZEN_API_KEY ?? "",
    /** Model identifier */
    model: Bun.env.SMALL_MODEL_MODEL ?? "gpt-5-nano",
    /** Provider type for self-hosted: "ollama" | "openai". If unset, uses provider registry. */
    providerType: Bun.env.SMALL_MODEL_PROVIDER_TYPE as
      | "ollama"
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
    apiKey: Bun.env.ZEN_API_KEY ?? "",
    baseUrl: Bun.env.ZEN_BASE_URL ?? "https://opencode.ai/zen/v1",
    goBaseUrl: Bun.env.ZEN_GO_BASE_URL ?? "https://opencode.ai/zen/go/v1",
  },

  /** OpenRouter — multi-provider gateway (OpenAI-compatible) */
  openrouter: {
    apiKey: Bun.env.OPENROUTER_API_KEY ?? "",
  },

  /** Context window management */
  context: {
    /** Max tokens for the model's context window */
    maxTokens: parseInt(Bun.env.CONTEXT_MAX_TOKENS ?? "262144", 10),
    /** Reserve tokens for the model's response */
    responseReserve: parseInt(Bun.env.CONTEXT_RESPONSE_RESERVE ?? "8192", 10),
    /** Trigger compaction at this utilization ratio (0.0 - 1.0) */
    compactionThreshold: parseFloat(
      Bun.env.CONTEXT_COMPACTION_THRESHOLD ?? "0.8",
    ),
    /** Keep this many recent conversation turns after compaction */
    keepRecentMessages: parseInt(Bun.env.CONTEXT_KEEP_RECENT ?? "50", 10),
    /** Keep this many recent tool results; older ones are pruned before sending to LLM */
    keepRecentToolResults: parseInt(
      Bun.env.CONTEXT_KEEP_RECENT_TOOL_RESULTS ?? "20",
      10,
    ),
  },

  /** Hooks — behavioral enforcement */
  hooks: {
    /** Enable the audit logger (default: true) */
    auditLog: Bun.env.HOOKS_AUDIT_LOG !== "false",
    /** Enable the destructive action guard (default: true) */
    destructiveGuard: Bun.env.HOOKS_DESTRUCTIVE_GUARD !== "false",
    /** Enable the tool hierarchy enforcer (default: true) */
    hierarchyEnforcer: Bun.env.HOOKS_HIERARCHY_ENFORCER !== "false",
    /** Enable background task auto-detection (default: true) */
    backgroundTaskManager: Bun.env.HOOKS_BACKGROUND_TASKS !== "false",
    /** Enable Cartographer post-edit trigger (default: true) */
    cartographerTrigger: Bun.env.HOOKS_CARTOGRAPHER_TRIGGER !== "false",
    /** Enable flailing detection (default: true) */
    flailingDetection: Bun.env.HOOKS_FLAILING_DETECTION !== "false",
  },

  /** Flailing detection — intervene when model is stuck in loops */
  flailing: {
    /** Score threshold to trigger a nudge (0.0 - 1.0) */
    nudgeThreshold: parseFloat(Bun.env.FLAILING_NUDGE_THRESHOLD ?? "0.6"),
    /** Max nudges before stronger denial message */
    maxNudges: parseInt(Bun.env.FLAILING_MAX_NUDGES ?? "4", 10),
    /** Rolling window size for tool call history */
    windowSize: parseInt(Bun.env.FLAILING_WINDOW_SIZE ?? "20", 10),
  },

  /** Conversation TTL in days (prune older conversations on startup) */
  conversationTtlDays: parseInt(Bun.env.CONVERSATION_TTL_DAYS ?? "30", 10),

  /** System prompt — loaded from markdown file */
  systemPromptPath: Bun.env.SYSTEM_PROMPT_PATH ?? "./system-prompt.md",
} as const;

/** Fixed external API endpoints */
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";
