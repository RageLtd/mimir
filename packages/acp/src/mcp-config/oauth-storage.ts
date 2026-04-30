/**
 * Disk-backed OAuth client provider for the MCP TypeScript SDK.
 *
 * Implements the SDK's `OAuthClientProvider` interface, persisting client
 * registration data, access/refresh tokens, and PKCE verifiers to
 * `~/.mimir/oauth/<server-name>/` so the OAuth state survives across
 * sessions and process restarts. The MCP SDK calls these methods during
 * `transport.connect()` and `transport.finishAuth()` — we just hand it
 * a persistence layer.
 *
 * Storage layout (per server):
 *   ~/.mimir/oauth/<server-name>/
 *     client.json    — OAuthClientInformationMixed (client_id, client_secret)
 *     tokens.json    — OAuthTokens (access_token, refresh_token, expires_in)
 *     verifier.json  — { verifier: string } (PKCE, set during in-flight flows)
 *
 * Files are written atomically via Bun.write — partial writes during a
 * crash leave the previous version intact. Missing files are treated as
 * "not yet authenticated" and yield `undefined` from the readers.
 */

import { mkdir } from "node:fs/promises";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { createChildLogger, log } from "../utils/log";

const logger = createChildLogger(log, "oauth-storage");

const expandHome = (p: string) =>
  p.startsWith("~/") ? `${Bun.env.HOME}/${p.slice(2)}` : p;

/**
 * Default base directory for OAuth state. Overridable via
 * `$MIMIR_OAUTH_DIR` for tests and unusual setups.
 */
const oauthBaseDir = () =>
  Bun.env.MIMIR_OAUTH_DIR
    ? expandHome(Bun.env.MIMIR_OAUTH_DIR)
    : `${Bun.env.HOME}/.mimir/oauth`;

const serverDir = (serverName: string) => `${oauthBaseDir()}/${serverName}`;

const clientPath = (serverName: string) =>
  `${serverDir(serverName)}/client.json`;
const tokensPath = (serverName: string) =>
  `${serverDir(serverName)}/tokens.json`;
const verifierPath = (serverName: string) =>
  `${serverDir(serverName)}/verifier.json`;

/** Read a JSON file, returning the parsed value or null. */
const readJson = async (path: string) => {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return file.json().then(
    (value: unknown) => ({ ok: true as const, value }),
    (error: unknown) => ({
      ok: false as const,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
};

/** Write a JSON file under `serverDir`, creating directories as needed. */
const writeJson = async (path: string, value: unknown) => {
  const dir = path.substring(0, path.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await Bun.write(path, JSON.stringify(value, null, 2));
};

/**
 * Default OAuth client metadata used when registering with a server.
 * `satisfies` verifies the literal against the SDK type without
 * collapsing it to the interface for callers.
 */
const buildClientMetadata = (redirectUrl: string) =>
  ({
    redirect_uris: [redirectUrl],
    client_name: "Mimir ACP Agent",
    client_uri: "https://github.com/rageltd/mimir",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }) satisfies OAuthClientMetadata;

export type OAuthStorageOptions = {
  readonly serverName: string;
  readonly redirectUrl: string;
  /**
   * Called when the SDK wants to redirect the user agent. Defaults to a
   * no-op so tests and headless flows can omit interaction. The flow
   * orchestrator wires this to a browser opener.
   */
  readonly onRedirect?: (url: URL) => void | Promise<void>;
};

/**
 * Build an OAuth client provider backed by disk under
 * `~/.mimir/oauth/<server-name>/`. The returned object satisfies the MCP
 * SDK's `OAuthClientProvider` interface and can be passed to
 * `StreamableHTTPClientTransport`'s `authProvider` option.
 */
export const createOAuthStorage = (options: OAuthStorageOptions) => {
  const { serverName, redirectUrl, onRedirect } = options;

  return {
    redirectUrl,
    clientMetadata: buildClientMetadata(redirectUrl),

    async clientInformation() {
      const result = await readJson(clientPath(serverName));
      if (result === null) return undefined;
      if (!result.ok) {
        logger.warn(
          "%s: client.json unreadable — %s",
          serverName,
          result.error,
        );
        return undefined;
      }
      // Trust the on-disk shape; the SDK validates against its zod schemas
      // when it consumes the value, so a stale/wrong file fails closer to
      // the call site than to our serialization boundary.
      return result.value as OAuthClientInformationMixed;
    },

    async saveClientInformation(
      info: OAuthClientInformationFull | OAuthClientInformation,
    ) {
      await writeJson(clientPath(serverName), info);
      logger.info("%s: client information saved", serverName);
    },

    async tokens() {
      const result = await readJson(tokensPath(serverName));
      if (result === null) return undefined;
      if (!result.ok) {
        logger.warn(
          "%s: tokens.json unreadable — %s",
          serverName,
          result.error,
        );
        return undefined;
      }
      return result.value as OAuthTokens;
    },

    async saveTokens(tokens: OAuthTokens) {
      await writeJson(tokensPath(serverName), tokens);
      logger.info("%s: tokens saved", serverName);
    },

    async redirectToAuthorization(authorizationUrl: URL) {
      if (onRedirect) await onRedirect(authorizationUrl);
    },

    async saveCodeVerifier(verifier: string) {
      await writeJson(verifierPath(serverName), { verifier });
    },

    async codeVerifier() {
      const result = await readJson(verifierPath(serverName));
      if (result === null || !result.ok) {
        // Returning empty string here lets the SDK surface the missing
        // verifier as a token-exchange failure rather than crashing in
        // our adapter — clearer error.
        logger.warn(
          "%s: verifier.json missing or unreadable — token exchange will fail",
          serverName,
        );
        return "";
      }
      const value = result.value as { verifier?: unknown };
      return typeof value.verifier === "string" ? value.verifier : "";
    },

    async invalidateCredentials(
      scope: "all" | "client" | "tokens" | "verifier" | "discovery",
    ) {
      const targets =
        scope === "all"
          ? (["client", "tokens", "verifier"] as const)
          : scope === "discovery"
            ? ([] as const)
            : ([scope] as const);
      for (const target of targets) {
        const path =
          target === "client"
            ? clientPath(serverName)
            : target === "tokens"
              ? tokensPath(serverName)
              : verifierPath(serverName);
        const file = Bun.file(path);
        if (await file.exists()) {
          await file.delete();
          logger.info("%s: invalidated %s", serverName, target);
        }
      }
    },
  } satisfies OAuthClientProvider;
};

/**
 * Read currently-stored tokens for a server without instantiating a full
 * provider. Used by the auth-injector to attach a Bearer header to the
 * SDK's `mcpServers` config when a previous OAuth flow has succeeded.
 */
export const readStoredAccessToken = async (serverName: string) => {
  const result = await readJson(tokensPath(serverName));
  if (result === null || !result.ok) return null;
  const tokens = result.value as { access_token?: unknown };
  return typeof tokens.access_token === "string" ? tokens.access_token : null;
};
