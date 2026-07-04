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

  /** Provider/model metadata source (models.dev shape). Fetched into memory
   *  at boot and refreshed on a TTL — no disk artifact (MIM-65). */
  providerData: {
    url: Bun.env.PROVIDER_DATA_URL ?? "https://models.dev/api.json",
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

  /** Memory hygiene — periodic background sweep that consolidates near-duplicate
   *  memories and forgets low-value ones. Runs in-process, guarded by a DB lock. */
  hygiene: {
    /** Whether the periodic scheduler runs at all. Manual /v1/hygiene/sweep
     *  works regardless of this flag. */
    enabled: (Bun.env.HYGIENE_ENABLED ?? "true") === "true",
    /** Interval between automatic sweeps, in ms. Default 6 hours. */
    intervalMs: parseInt(
      Bun.env.HYGIENE_INTERVAL_MS ?? `${6 * 60 * 60 * 1000}`,
      10,
    ),
    /** When true, the sweep computes and reports proposed merges/prunes but
     *  mutates nothing. Default true — destructive operation, opt out
     *  explicitly once thresholds are tuned against a real store. */
    dryRun: (Bun.env.HYGIENE_DRY_RUN ?? "true") === "true",
    /** Consolidation judgment model. Env-only, NO default — the sweep refuses
     *  to run when this is unset rather than silently hitting the wrong model.
     *  Routes through opencode-go (OpenAI Chat Completions shape) by default. */
    model: Bun.env.HYGIENE_MODEL,
    /** OpenAI-compatible endpoint for the hygiene model. Defaults to opencode-go. */
    baseUrl:
      Bun.env.HYGIENE_MODEL_BASE_URL ??
      Bun.env.ZEN_GO_BASE_URL ??
      "https://opencode.ai/zen/go/v1",
    /** Credential for the hygiene model endpoint. Shares the OpenCode key. */
    apiKey: Bun.env.HYGIENE_MODEL_API_KEY ?? Bun.env.OPENCODE_API_KEY ?? "",
    /** Max completion tokens for a merge call. Generous because reasoning
     *  models (GLM-5.1) spend most of the budget thinking before they emit the
     *  short merged statement — too low and `content` comes back empty. */
    maxTokens: parseInt(Bun.env.HYGIENE_MAX_TOKENS ?? "8192", 10),
    consolidation: {
      /** Merge memories whose pairwise embedding distance is at or below this.
       *  Looser than the 0.05 write-time dedup, far tighter than the 0.3
       *  neighbor-edge threshold — only fuse memories that truly overlap.
       *  0.18 was validated against the real store (130 memories): every
       *  cluster up to that distance was a true same-subject pair, zero false
       *  positives; the looser 0.08 default under-merged (missed exact dupes). */
      mergeDistance: parseFloat(Bun.env.HYGIENE_MERGE_DISTANCE ?? "0.18"),
      /** Max memories folded into one canonical record per cluster. */
      maxClusterSize: parseInt(Bun.env.HYGIENE_MAX_CLUSTER_SIZE ?? "5", 10),
      /** Hard cap on merges applied in a single sweep — a threshold bug can't
       *  collapse the whole store in one pass. */
      maxMergesPerSweep: parseInt(Bun.env.HYGIENE_MAX_MERGES ?? "20", 10),
    },
    forget: {
      /** Prune memories whose combined score falls below this floor. */
      scoreFloor: parseFloat(Bun.env.HYGIENE_SCORE_FLOOR ?? "0.15"),
      /** Never prune memories younger than this many days, regardless of score —
       *  a fact deserves a chance to be accessed before it's reaped. */
      minAgeDays: parseInt(Bun.env.HYGIENE_MIN_AGE_DAYS ?? "14", 10),
      /** Multiplicative confidence decay applied each sweep to memories not
       *  accessed since the previous sweep. Gives confidence a real time signal
       *  instead of sitting frozen at 1.0 forever. */
      confidenceDecay: parseFloat(Bun.env.HYGIENE_CONFIDENCE_DECAY ?? "0.9"),
      /** Hard cap on deletions applied in a single sweep. */
      maxPrunesPerSweep: parseInt(Bun.env.HYGIENE_MAX_PRUNES ?? "50", 10),
    },
    contradiction: {
      /** Whether the contradiction pass runs at all. */
      enabled: (Bun.env.HYGIENE_CONTRADICTION_ENABLED ?? "true") === "true",
      /** Upper distance bound for a contradiction candidate pair. Pairs at or
       *  below mergeDistance (0.18) are consolidation's job; this is the ceiling
       *  of the band ABOVE that, where conflicting-but-differently-worded claims
       *  live. 0.30 matches the existing neighbour-edge threshold — tune from
       *  dry runs before widening (false positives expected past it). */
      contradictionDistance: parseFloat(
        Bun.env.HYGIENE_CONTRADICTION_DISTANCE ?? "0.30",
      ),
      /** Hard cap on judge calls per sweep — each candidate pair costs one
       *  model call in BOTH dry and live runs, so this bounds sweep cost. */
      maxChecks: parseInt(Bun.env.HYGIENE_CONTRADICTION_MAX_CHECKS ?? "20", 10),
      /** Multiply a superseded fact's confidence by this on a confirmed
       *  contradiction. Sharper than the routine 0.9 untouched-decay because a
       *  contradiction is a stronger signal; 0.3 still leaves a 1.0 fact above
       *  the 0.15 prune floor for one sweep rather than reaping it instantly. */
      demotionFactor: parseFloat(
        Bun.env.HYGIENE_CONTRADICTION_DEMOTION_FACTOR ?? "0.3",
      ),
    },
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
    /** Max tokens of rendered recent-history to inject into the assembled
     *  CC system prompt. Trimmed newest-first; 0 disables the cap. Uses
     *  gpt-tokenizer (cl100k_base) as a rough but fast proxy — Anthropic
     *  doesn't ship a public tokenizer, and a slight overcount is desirable
     *  for a budget. */
    assemblyTokenBudget: parseInt(
      Bun.env.CONTEXT_ASSEMBLY_TOKEN_BUDGET ?? "12000",
      10,
    ),
  },

  /** System prompt — loaded from markdown file */
  systemPromptPath: Bun.env.SYSTEM_PROMPT_PATH ?? "./system-prompt.md",
} as const;

/** Fixed external API endpoints */
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";
