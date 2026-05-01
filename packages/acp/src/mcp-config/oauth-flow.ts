/**
 * OAuth flow orchestrator for HTTP MCP servers.
 *
 * Drives the authorization-code-with-PKCE dance end-to-end:
 *   1. Bind a one-shot localhost listener that captures the OAuth callback.
 *   2. Build an `OAuthClientProvider` (disk-backed) pointing at that port.
 *   3. Open the user's browser to the authorization URL.
 *   4. Wait for the callback to deliver the authorization code.
 *   5. Hand the code to `transport.finishAuth(code)`, which completes the
 *      token exchange. The provider's `saveTokens` writes them to disk.
 *   6. Tear down the listener.
 *
 * The MCP TypeScript SDK does the actual OAuth protocol work (RFC 9728
 * resource discovery, authorization-server metadata, dynamic client
 * registration, PKCE, token exchange, refresh). We just persist state
 * and wire up the callback channel.
 *
 * The caller (`/mcp <name> auth` handler or the eager-auth wiring in
 * session lifecycle) gets back a `{ ok, accessToken? }` result and
 * decides what to do with it — typically updates the session's
 * `clientMcpServers` to include an `Authorization: Bearer <token>`
 * header and triggers a CC fresh-session rotation so the model picks up
 * the newly-available tools on its next prompt.
 */

import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { errMessage } from "../util";
import { createChildLogger, log } from "../utils/log";
import { createOAuthStorage } from "./oauth-storage";

const logger = createChildLogger(log, "oauth-flow");

/** Pause window for the user to approve in the browser before we give up. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const CALLBACK_PATH = "/callback";

const BROWSER_OPEN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Authentication Complete</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:24px;color:#333}h1{color:#1a7f37}p{line-height:1.5}</style>
</head><body>
<h1>✓ Authentication complete</h1>
<p>You can close this window and return to your editor. The MCP server's tools will become visible on your next prompt.</p>
</body></html>`;

const BROWSER_FAIL_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Authentication Failed</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:24px;color:#333}h1{color:#cf222e}p{line-height:1.5}code{background:#f6f8fa;padding:2px 6px;border-radius:3px}</style>
</head><body>
<h1>✗ Authentication failed</h1>
<p>The OAuth callback did not include an authorization code. Check the editor for details and try again.</p>
</body></html>`;

/** Open a URL in the user's default browser. Best-effort; logs on failure. */
const openInBrowser = async (url: string) => {
  const platform = process.platform;
  const command =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const proc = Bun.spawn(command, {
    stderr: "ignore",
    stdout: "ignore",
  });
  // Don't await — `open` and friends fork and return immediately on most
  // platforms, but spawn returning is enough. Errors are surfaced via the
  // exit code which we don't block on.
  proc.exited
    .then((code) => {
      if (code !== 0) {
        logger.warn(
          "browser launcher exited with code %d (command: %s)",
          code,
          command.join(" "),
        );
      }
    })
    .catch((err: unknown) =>
      logger.warn("browser launcher failed: %s", errMessage(err)),
    );
};

type CallbackResult = { ok: true; code: string } | { ok: false; error: string };

/**
 * Stand up a one-shot callback listener that resolves once the OAuth
 * provider redirects back with an authorization code (or an error).
 * Returns the bound port plus a Promise for the result and a stop fn.
 */
const startCallbackServer = (timeoutMs: number) => {
  let resolveResult: (value: CallbackResult) => void;
  const resultPromise = new Promise<CallbackResult>((resolve) => {
    resolveResult = resolve;
  });

  const server = Bun.serve({
    port: 0, // Bun picks a free port
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== CALLBACK_PATH) {
        return new Response("Not Found", { status: 404 });
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) {
        const description = url.searchParams.get("error_description") ?? error;
        resolveResult({ ok: false, error: description });
        return new Response(BROWSER_FAIL_HTML, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      if (!code) {
        resolveResult({ ok: false, error: "callback missing `code` param" });
        return new Response(BROWSER_FAIL_HTML, {
          status: 400,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      resolveResult({ ok: true, code });
      return new Response(BROWSER_OPEN_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });

  // Wire up timeout that resolves the same promise if no callback fires.
  const timer = setTimeout(() => {
    resolveResult({
      ok: false,
      error: `callback timed out after ${Math.round(timeoutMs / 1000)}s`,
    });
  }, timeoutMs);

  const stop = async () => {
    clearTimeout(timer);
    await server.stop(true);
  };

  return {
    port: server.port,
    resultPromise,
    stop,
  };
};

export type OAuthFlowOptions = {
  readonly serverName: string;
  readonly serverUrl: string;
  /** Optional headers to forward on the MCP connection (e.g. user-agent). */
  readonly extraHeaders?: Record<string, string>;
  /** How long to wait for the user to complete the browser flow. */
  readonly timeoutMs?: number;
};

export type OAuthFlowResult =
  | { readonly ok: true; readonly accessToken: string }
  | { readonly ok: false; readonly error: string };

/**
 * Run the OAuth flow for a single MCP server. On success, tokens are
 * persisted to `~/.mimir/oauth/<serverName>/` and the access token is
 * returned for immediate use as a Bearer header. On failure, returns
 * a diagnostic message — caller logs and surfaces to the user.
 */
export const runOAuthFlow = async (options: OAuthFlowOptions) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const callback = startCallbackServer(timeoutMs);
  const redirectUrl = `http://localhost:${callback.port}${CALLBACK_PATH}`;
  logger.info(
    "%s: OAuth flow starting (callback %s)",
    options.serverName,
    redirectUrl,
  );

  const authProvider = createOAuthStorage({
    serverName: options.serverName,
    redirectUrl,
    onRedirect: async (url) => {
      logger.info(
        "%s: opening browser for OAuth approval — %s",
        options.serverName,
        url.toString(),
      );
      await openInBrowser(url.toString());
    },
  });

  const transport = new StreamableHTTPClientTransport(
    new URL(options.serverUrl),
    {
      authProvider,
      requestInit: options.extraHeaders
        ? { headers: options.extraHeaders }
        : undefined,
    },
  );

  const client = new Client({
    name: "mimir-acp-oauth",
    version: "1.0.0",
  });

  // First connect attempt. If the server requires auth, this throws
  // `UnauthorizedError` AFTER `redirectToAuthorization` has fired the
  // browser. We catch that and wait for the callback.
  const connectResult = await client.connect(transport).then(
    () => ({ ok: true as const }),
    (err: unknown) => ({ ok: false as const, error: err }),
  );

  if (!connectResult.ok) {
    // The MCP SDK's `UnauthorizedError` extends Error but doesn't set
    // `this.name`, so name-string matching always misses. `instanceof`
    // is the durable check.
    const isUnauthorized = connectResult.error instanceof UnauthorizedError;
    if (!isUnauthorized) {
      await callback.stop();
      const message = errMessage(connectResult.error);
      logger.warn(
        "%s: connect failed with non-auth error — %s",
        options.serverName,
        message,
      );
      return { ok: false, error: message } satisfies OAuthFlowResult;
    }
    // Wait for the callback to complete the flow.
    const cbResult = await callback.resultPromise;
    await callback.stop();
    if (!cbResult.ok) {
      logger.warn(
        "%s: OAuth callback failed — %s",
        options.serverName,
        cbResult.error,
      );
      return { ok: false, error: cbResult.error } satisfies OAuthFlowResult;
    }
    // Exchange the code for tokens. The SDK calls `saveTokens` internally.
    const finishResult = await transport.finishAuth(cbResult.code).then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, error: errMessage(err) }),
    );
    if (!finishResult.ok) {
      logger.warn(
        "%s: token exchange failed — %s",
        options.serverName,
        finishResult.error,
      );
      return {
        ok: false,
        error: finishResult.error,
      } satisfies OAuthFlowResult;
    }
    // No reconnect needed — `finishAuth` has persisted the tokens via
    // `saveTokens`, which is the only side effect we care about. The
    // Claude Agent SDK opens its own connection later using the
    // Authorization header we'll inject from disk. Calling
    // `client.connect(transport)` again here throws because the
    // transport's already started, and a fresh transport+client just
    // to surface "post-auth connection works" duplicates work the
    // CC SDK is about to do anyway.
  } else {
    // Stored tokens were valid — happy path with no browser interaction.
    await callback.stop();
  }

  // Close the diagnostic client; the Claude Agent SDK will open its own
  // connection later using the bearer token we just persisted.
  await client.close().catch((err: unknown) => {
    logger.debug(
      "%s: client.close after auth failed — %s",
      options.serverName,
      errMessage(err),
    );
  });

  // Read the persisted access token to hand back to the caller.
  const tokens = await authProvider.tokens();
  if (!tokens?.access_token) {
    return {
      ok: false,
      error: "auth completed but no access_token was persisted",
    } satisfies OAuthFlowResult;
  }
  logger.info("%s: OAuth flow completed successfully", options.serverName);
  return {
    ok: true,
    accessToken: tokens.access_token,
  } satisfies OAuthFlowResult;
};
