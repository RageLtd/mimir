/** Dedicated operator boundary for the server-introspection MCP surface. */

import type { Context, Next } from "hono";
import { tokenMatches } from "../auth/claim";
import { config } from "../config";
import { operatorTokenDigest } from "../operator/state";
import { log } from "../util/logger";
import { attempt } from "../util/result";

const BEARER_PREFIX = "Bearer ";

export const isOperatorMcpPath = (path: string) =>
  path === "/mcp" || path.startsWith("/mcp/");

export type OperatorCredentialDigestLookup = () =>
  | Promise<string | null>
  | string
  | null;

export const createOperatorGate =
  (
    expectedToken = config.operator.token,
    digestLookup: OperatorCredentialDigestLookup = () => null,
  ) =>
  async (c: Context, next: Next) => {
    if (!isOperatorMcpPath(c.req.path)) return next();

    const [lookupError, storedDigest] = await attempt(() =>
      Promise.resolve(digestLookup()),
    );
    if (lookupError) {
      log.error(
        { err: lookupError },
        "operator MCP credential lookup failed — rejecting",
      );
      return c.json({ error: { message: "Unavailable" } }, 503);
    }

    if (!storedDigest && !expectedToken) {
      log.warn(
        "operator MCP request rejected — MIMIR_OPERATOR_TOKEN is not configured",
      );
      return c.json({ error: { message: "Not Found" } }, 404);
    }

    const authorization = c.req.header("authorization") ?? "";
    const presented = authorization.startsWith(BEARER_PREFIX)
      ? authorization.slice(BEARER_PREFIX.length).trim()
      : "";
    const valid = storedDigest
      ? tokenMatches(operatorTokenDigest(presented), storedDigest)
      : tokenMatches(presented, expectedToken);
    if (!valid) {
      log.warn("operator MCP request rejected — invalid operator credential");
      return c.json({ error: { message: "Unauthorized" } }, 401);
    }

    return next();
  };
