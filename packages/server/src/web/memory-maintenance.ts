import type { Context } from "hono";
import type {
  AppendOrganizationAuditEvent,
  OrganizationAuditMetadata,
} from "../audit/store";
import type { IdentityEnv } from "../middleware/identity";
import { attempt, attemptSync } from "../util/result";
import { hasTrustedOrigin } from "./forms";

const JSON_CONTENT_TYPE = "application/json";
const MAX_MAINTENANCE_BATCH = 1_000;
const OPAQUE_ID = /^[A-Za-z0-9:_-]{1,200}$/;

export interface OrganizationMemoryMaintenanceOptions {
  origin: string;
  push: (envelopes: unknown[], headers: Headers) => Promise<Response>;
  audit: (event: AppendOrganizationAuditEvent) => unknown;
  id?: () => string;
}

function forwardedHeaders(c: Context<IdentityEnv>) {
  const headers = new Headers(c.req.raw.headers);
  headers.delete("content-length");
  headers.set("content-type", JSON_CONTENT_TYPE);
  return headers;
}

function requestId(c: Context<IdentityEnv>, id: () => string) {
  const supplied = c.req.header("x-request-id");
  return supplied && OPAQUE_ID.test(supplied) ? supplied : id();
}

function envelopeId(value: unknown) {
  if (typeof value !== "object" || value === null || !("id" in value)) {
    return null;
  }
  return typeof value.id === "string" && OPAQUE_ID.test(value.id)
    ? value.id
    : null;
}

function readResult(value: unknown, expected: number) {
  if (typeof value !== "object" || value === null) return null;
  if (!("accepted" in value) || !Number.isSafeInteger(value.accepted)) {
    return null;
  }
  if (!("stale" in value) || !Array.isArray(value.stale)) return null;
  const stale = value.stale.filter(
    (candidate): candidate is string => typeof candidate === "string",
  );
  if (stale.length !== value.stale.length) return null;
  return {
    complete: value.accepted === expected && stale.length === 0,
    conflict: stale.length > 0,
  };
}

function appendAudit(
  options: OrganizationMemoryMaintenanceOptions,
  input: {
    orgId: string;
    actorUserId: string;
    targetId: string;
    requestId: string;
    count: number;
  },
  outcome: "intent" | "succeeded" | "failed",
  metadata: OrganizationAuditMetadata,
) {
  return attemptSync(() =>
    options.audit({
      orgId: input.orgId,
      actorUserId: input.actorUserId,
      action: "memory.maintenance",
      targetType: "memory-set",
      targetId: input.targetId,
      outcome,
      requestId: input.requestId,
      metadata: { count: input.count, ...metadata },
    }),
  )[0];
}

const unavailable = () =>
  Response.json({ error: "Memory maintenance unavailable" }, { status: 503 });

export const createMemoryMaintenanceAction =
  (options: OrganizationMemoryMaintenanceOptions) =>
  async (c: Context<IdentityEnv>) => {
    const identity = c.get("identity");
    const contentType = c.req.header("content-type")?.split(";", 1)[0]?.trim();
    if (
      !identity ||
      !hasTrustedOrigin(c, options) ||
      contentType !== JSON_CONTENT_TYPE
    ) {
      return c.json({ error: "Forbidden" }, 403);
    }
    const [parseError, body] = await attempt(() => c.req.json<unknown>());
    if (parseError || typeof body !== "object" || body === null) {
      return c.json({ error: "Invalid request" }, 400);
    }
    const envelopes =
      "envelopes" in body && Array.isArray(body.envelopes)
        ? body.envelopes
        : null;
    if (
      !envelopes ||
      envelopes.length === 0 ||
      envelopes.length > MAX_MAINTENANCE_BATCH
    ) {
      return c.json({ error: "Invalid request" }, 400);
    }

    const id = options.id ?? (() => crypto.randomUUID());
    const correlationId = requestId(c, id);
    const singleTarget =
      envelopes.length === 1 ? envelopeId(envelopes[0]) : null;
    const auditInput = {
      orgId: identity.orgId,
      actorUserId: identity.userId,
      targetId: singleTarget ?? `memory-set:${id()}`,
      requestId: correlationId,
      count: envelopes.length,
    };
    if (appendAudit(options, auditInput, "intent", {})) return unavailable();

    const [pushError, response] = await attempt(() =>
      options.push(envelopes, forwardedHeaders(c)),
    );
    if (pushError) {
      appendAudit(options, auditInput, "failed", { reasonCode: "dependency" });
      return unavailable();
    }
    const [resultError, resultBody] = await attempt(async () => {
      const value: unknown = await response.clone().json();
      return value;
    });
    const result = resultError
      ? null
      : readResult(resultBody, envelopes.length);
    const succeeded = response.ok && result?.complete;
    const auditError = appendAudit(
      options,
      auditInput,
      succeeded ? "succeeded" : "failed",
      succeeded
        ? {}
        : { reasonCode: result?.conflict ? "conflict" : "dependency" },
    );
    if (auditError) return unavailable();
    return result ? response : unavailable();
  };
