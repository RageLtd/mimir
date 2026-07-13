/** Dedicated operator boundary for the server-introspection MCP surface. */

import type { Context, Next } from "hono";
import { tokenMatches } from "../auth/claim";
import { config } from "../config";
import { log } from "../util/logger";

const BEARER_PREFIX = "Bearer ";

export const isOperatorPath = (path: string) =>
  path === "/mcp" || path.startsWith("/mcp/");

export const createOperatorGate =
  (expectedToken = config.operator.token) =>
  async (c: Context, next: Next) => {
    if (!isOperatorPath(c.req.path)) return next();

    if (!expectedToken) {
      log.warn(
        "operator MCP request rejected — MIMIR_OPERATOR_TOKEN is not configured",
      );
      return c.json({ error: { message: "Not Found" } }, 404);
    }

    const authorization = c.req.header("authorization") ?? "";
    const presented = authorization.startsWith(BEARER_PREFIX)
      ? authorization.slice(BEARER_PREFIX.length).trim()
      : "";
    if (!tokenMatches(presented, expectedToken)) {
      log.warn("operator MCP request rejected — invalid operator credential");
      return c.json({ error: { message: "Unauthorized" } }, 401);
    }

    return next();
  };
