/**
 * Local memory extraction (MIM-86) — the server's goldfish extraction
 * relocated to where the transcript originates. The system prompt is a
 * VERBATIM port of packages/server/src/goldfish/clients.ts (parity with
 * today's behavior is the ticket's goal — measured on the same inputs).
 *
 * Provider is user-chosen (Rage's call): a plain OpenAI-compatible
 * endpoint described by {baseUrl, model, apiKey} — no provider registry,
 * no server round-trip. Works against Ollama/vLLM/llama-server/cloud
 * endpoints alike. No key required for local endpoints.
 *
 * Failure contract mirrors MIM-74's hard rule transitively: extraction
 * failure returns [] — memories just don't get extracted this turn; the
 * transcript watermark stays put so the next turn retries.
 */

import { attempt } from "../result";

/** User-chosen extraction endpoint. */
export type ExtractionConfig = {
  readonly baseUrl: string;
  readonly model: string;
  /** Empty/undefined for keyless local endpoints (Ollama, vLLM). */
  readonly apiKey?: string;
};

// ── Verbatim from server goldfish/clients.ts (do not edit casually —
//    parity with server-side extraction is measured, not assumed) ──

const EXTRACTION_SYSTEM_PROMPT = `You extract factual memories from development conversations. Output ONLY a JSON array of strings. Each memory should be a specific fact useful in FUTURE conversations.

EXTRACT:
- Architecture decisions and system design
- Technology choices and why they were made
- Bugs found and their root causes
- User preferences (coding style, tools, workflow)
- Configuration details (ports, models, settings)
- Project structure and relationships between components

SKIP:
- Greetings and pleasantries
- Raw file listings or directory paths
- Tool invocation details
- Anything only useful in the current session

If the conversation is just a greeting or trivial exchange, return []. But if there is substantive technical content, extract it.

<example>
Input:
user: The gateway service keeps timing out on large queries
assistant: The issue is the request service's default timeout is 30s. For aggregation queries over 1M rows, ClickHouse needs more time. I've set the gateway proxy timeout to 120s and added a per-query timeout parameter.
user: That fixed it, thanks

Output:
["Gateway was timing out on large queries because request service default timeout was 30s", "Gateway proxy timeout increased to 120s with per-query timeout parameter for large ClickHouse aggregations"]
</example>

<example>
Input:
user: Hey, can you look at the project?
assistant: Sure, I see a Rust + TypeScript monorepo with Hono for the gateway and Actix for the request service. ClickHouse is the primary data store.
user: Right, what tools do we use?
assistant: The stack uses cargo-make for task orchestration, Biome for TS linting, and cargo-zigbuild for cross-compilation to Linux musl targets.

Output:
["data-services is a Rust + TypeScript monorepo using Hono (gateway) and Actix (request service)", "ClickHouse is the primary data store", "Build tooling: cargo-make for tasks, Biome for TS linting, cargo-zigbuild for musl cross-compilation"]
</example>

Output format: ["memory 1", "memory 2", ...]
Return [] only if there is genuinely nothing technical or factual to extract.`;

const EXTRACTION_MAX_TOKENS = 2048;
const EXTRACTION_TIMEOUT_MS = 60_000;
const EXTRACTION_TEMPERATURE = 0.1;

const logErr = (msg: string) => {
  process.stderr.write(`[mimir-extract] ${msg}\n`);
};

/** OpenAI Chat Completions response — serialisation boundary. */
type ChatCompletionResponse = {
  choices?: { message?: { content?: string } }[];
};

/**
 * One OpenAI-compatible chat completion against the user-chosen endpoint.
 * Shared by extraction and summarization (brain/summarize.ts) so the
 * transport, auth, and error behavior can't drift between the two.
 * Null on any failure.
 */
export const completeChat = async (
  config: ExtractionConfig,
  opts: {
    readonly system: string;
    readonly user: string;
    readonly maxTokens: number;
    readonly timeoutMs: number;
  },
) => {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  // Keyless local endpoints (Ollama, vLLM) get no Authorization header.
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const [err, res] = await attempt(async () => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs),
      body: JSON.stringify({
        model: config.model,
        stream: false,
        temperature: EXTRACTION_TEMPERATURE,
        max_tokens: opts.maxTokens,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
      }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 200);
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }
    return (await response.json()) as ChatCompletionResponse;
  });

  if (err) {
    logErr(`completion failed: ${err.message}`);
    return null;
  }
  const content = res.choices?.[0]?.message?.content?.trim();
  if (!content) {
    logErr("completion returned empty content");
    return null;
  }
  return content;
};

const completeExtraction = (
  config: ExtractionConfig,
  conversationText: string,
) =>
  completeChat(config, {
    system: EXTRACTION_SYSTEM_PROMPT,
    user: conversationText,
    maxTokens: EXTRACTION_MAX_TOKENS,
    timeoutMs: EXTRACTION_TIMEOUT_MS,
  });

/**
 * Extract memory strings from conversation text. NULL means transport or
 * parse FAILURE (callers keep their watermark and retry next turn); an
 * empty array is an honest "nothing worth keeping".
 */
export const extractMemories = async (
  config: ExtractionConfig,
  conversationText: string,
) => {
  if (!conversationText.trim()) return [];

  const content = await completeExtraction(config, conversationText);
  if (content === null) return null;

  const [parseErr, memories] = await attempt(async () => {
    // Models fond of markdown wrap the array in ```json fences.
    const cleaned = content.replace(/```json\n?|```/g, "").trim();
    return JSON.parse(cleaned) as unknown;
  });

  if (
    parseErr ||
    !Array.isArray(memories) ||
    !memories.every((m) => typeof m === "string")
  ) {
    logErr(
      `failed to parse extracted memories: ${parseErr?.message ?? "not a string array"}`,
    );
    return null;
  }
  return memories;
};

// ── Conversation rendering: parity port of server goldfish/memory.ts
//    buildExtractionText + its gates ──

/** Minimal structural message — matches AI SDK ModelMessage without the
 *  dependency. Content parts are transcript-boundary unknowns. */
export type ConversationMessage = {
  readonly role: string;
  readonly content: unknown;
};

const EXTRACTION_MAX_CHARS = 4000;
const MIN_USER_TURNS = 2;
const MIN_TEXT_CHARS = 200;
const MIN_ASSISTANT_CHARS = 20;

/** Text parts only — port of message-utils modelContentToString. */
export const contentToString = (content: unknown) => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => {
      // Transcript parts are a serialisation boundary — shape unknown.
      const part = p as { type?: unknown; text?: unknown };
      return part.type === "text" && typeof part.text === "string"
        ? part.text
        : "";
    })
    .filter((s) => s.length > 0)
    .join("\n");
};

/** Last message untruncated, fill backward within the char budget.
 *  Shared renderer — extraction uses the 4000-char parity budget,
 *  summarization (brain/summarize.ts) a much larger one. */
export const renderConversation = (
  messages: readonly ConversationMessage[],
  maxChars: number,
) => {
  const filtered = messages.filter((m) => {
    if (m.role === "tool" || m.role === "system") return false;
    const text = contentToString(m.content);
    if (!text) return false;
    if (m.role === "assistant" && text.trim().length < MIN_ASSISTANT_CHARS) {
      return false;
    }
    return true;
  });

  const lastMsg = filtered.at(-1);
  if (!lastMsg) return "";
  const lastLine = `${lastMsg.role}: ${contentToString(lastMsg.content)}`;
  const lines: string[] = [lastLine];
  let totalChars = lastLine.length;

  for (let i = filtered.length - 2; i >= 0; i--) {
    const msg = filtered[i];
    if (!msg) continue;
    const line = `${msg.role}: ${contentToString(msg.content)}`;
    if (totalChars + line.length > maxChars) break;
    lines.unshift(line);
    totalChars += line.length;
  }

  return lines.join("\n");
};

export const buildExtractionText = (messages: readonly ConversationMessage[]) =>
  renderConversation(messages, EXTRACTION_MAX_CHARS);

/**
 * Full pipeline: gate → render → extract. Server-parity gates: fewer than
 * two user turns or under 200 rendered chars skip extraction (skips are
 * SUCCESS — the caller advances its watermark). `ok: false` is transport
 * failure — keep the watermark, retry next turn. Discriminants are
 * `as const` so the inferred union discriminates without an annotation.
 */
export const extractFromConversation = async (
  config: ExtractionConfig,
  messages: readonly ConversationMessage[],
) => {
  const userTurns = messages.filter(
    (m) => m.role === "user" && contentToString(m.content),
  ).length;
  if (userTurns < MIN_USER_TURNS) {
    return {
      ok: true as const,
      memories: [] as string[],
      skipped: "fewer than 2 user turns",
    };
  }

  const text = buildExtractionText(messages);
  if (text.length < MIN_TEXT_CHARS) {
    return {
      ok: true as const,
      memories: [] as string[],
      skipped: "conversation too short",
    };
  }

  const memories = await extractMemories(config, text);
  if (memories === null) {
    return { ok: false as const, memories: null, skipped: null };
  }
  return { ok: true as const, memories, skipped: null };
};
