/**
 * Middleware pipeline — the ONE place the MimirContext is created and the
 * middleware chain is ordered.
 *
 * Both ingress routes (`/v1/chat/completions`, `/v1/messages`) translate
 * their wire format into a ChatRequest, then call `createMimirContext` +
 * `prepareContext`. Neither route owns pipeline knowledge: adding a
 * context field or a middleware stage touches this file only.
 */

import type { OrgScope } from "../db/scope";
import { ensureProjectId } from "../projects/store";
import { injectMemories } from "./goldfish";
import { injectProjectRules } from "./project-rules";
import { injectSystemPrompt } from "./system-prompt";
import { classifyTools } from "./tool-classification";
import type { ChatRequest, MimirContext, ProviderOverride } from "./types";
import { injectUserProfile } from "./user-profile";

/** Bucket for requests that carry no project metadata. */
const DEFAULT_PROJECT_IDENTIFIER = "default";

/** BYOK key transport header (MIM-73). Header, never body — request bodies
 *  get logged on validation failure; headers don't. */
export const PROVIDER_KEY_HEADER = "x-provider-api-key";

/**
 * Build the per-request BYOK override from the transport header + body
 * metadata. Shared by both ingress routes so they cannot drift. Returns
 * null when no key was sent — the keyless path stays byte-identical to
 * pre-MIM-73 behavior.
 */
export function extractProviderOverride(
  apiKeyHeader: string | undefined,
  metadata: ChatRequest["metadata"],
) {
  const apiKey = apiKeyHeader?.trim();
  if (!apiKey) return null;

  const override: ProviderOverride = { apiKey };
  if (typeof metadata?.provider === "string" && metadata.provider.length > 0) {
    override.provider = metadata.provider;
  }
  if (typeof metadata?.base_url === "string" && metadata.base_url.length > 0) {
    override.baseUrl = metadata.base_url;
  }
  if (
    typeof metadata?.small_model === "string" &&
    metadata.small_model.length > 0
  ) {
    override.smallModel = metadata.small_model;
  }
  return override;
}

/** Correlation ID for request logging. */
export function generateRequestId() {
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Build the initial context object for the pipeline.
 * Every field the middleware chain fills starts empty here.
 */
export function createMimirContext(
  request: ChatRequest,
  opts: { scope: OrgScope; providerOverride?: ProviderOverride | null },
) {
  return {
    request,
    scope: opts.scope,
    projectId: null,
    providerOverride: opts.providerOverride ?? null,
    systemPrompt: "",
    memories: null,
    playbooks: null,
    projectRules: null,
    conversationMessages: [],
    contextInjection: [],
    compactionTriggered: false,
    serverTools: {},
    clientTools: {},
    allTools: {},
    resolvedModel: null,
  };
}

/**
 * Run the middleware chain over a fresh context.
 *
 * A pre-set `ctx.systemPrompt` (the Anthropic ingress carries the client's
 * `system` field verbatim) short-circuits the system-prompt stage — the
 * fallback to the server's on-disk prompt only applies when the client
 * supplied nothing.
 *
 * Deliberately EXCLUDES context assembly. Assembly persists the client's
 * trailing turn and reads the log back — it must run inside the LLM-call
 * queue (see agent/run/turn.ts) so that persist→read→infer→persist is
 * atomic per turn. Running it here would let a request that arrives
 * mid-turn snapshot the log before the in-flight assistant reply lands.
 */
export async function prepareContext(ctx: MimirContext) {
  await resolveProjectId(ctx);
  if (!ctx.systemPrompt) await injectSystemPrompt(ctx);
  await injectMemories(ctx);
  injectUserProfile(ctx);
  injectProjectRules(ctx);
  await classifyTools(ctx);
  return ctx;
}

/**
 * Stage 0: resolve the client-sent project identifier (path or id) to the
 * canonical project ULID. Runs first — every downstream stage and the
 * message log key on ctx.projectId; no raw identifier survives past here.
 */
async function resolveProjectId(ctx: MimirContext) {
  const identifier =
    ctx.request.metadata?.project ?? DEFAULT_PROJECT_IDENTIFIER;
  const projectId = await ensureProjectId(identifier);
  if (!projectId) {
    throw new Error(
      `pipeline: failed to resolve project identifier "${identifier}" to a project record`,
    );
  }
  ctx.projectId = projectId;
}

/**
 * Assert the resolve stage has run. Downstream consumers (context
 * assembly, post-processing) call this instead of re-checking null —
 * a null here is a pipeline-ordering bug, not a data condition.
 */
export function requireProjectId(ctx: MimirContext) {
  if (!ctx.projectId) {
    throw new Error(
      "pipeline: ctx.projectId not resolved — resolveProjectId stage did not run",
    );
  }
  return ctx.projectId;
}
