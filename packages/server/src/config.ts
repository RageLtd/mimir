/** Central configuration — environment variables with sensible defaults */

export const config = {
  /** Mimir server */
  port: parseInt(Bun.env.MIMIR_PORT ?? "8080", 10),
  host: Bun.env.MIMIR_HOST ?? "0.0.0.0",

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
  },

  /** System prompt — loaded from markdown file */
  systemPromptPath: Bun.env.SYSTEM_PROMPT_PATH ?? "./system-prompt.md",

  /** MIM-88 tenant store — SQLite holding ciphertext envelopes, sync
   *  cursors, leases, and the project registry. Railway points this at
   *  the mounted volume (/data/mimir.sqlite); local default stays
   *  cwd-relative like auth.dbPath. */
  tenantDbPath: Bun.env.MIMIR_DB_PATH ?? "./mimir.sqlite",
} as const;
