/**
 * Hygiene model client — routes consolidation judgment to a deliberately
 * capable model (GLM-5.1 over opencode-go by default), separate from the small
 * Vulkan-bound extraction model.
 *
 * Env-only by design: if HYGIENE_MODEL is unset, getHygieneModelConfig returns
 * null and the sweep refuses to run rather than silently merging memories with
 * whatever model happens to be configured elsewhere.
 */

import { config } from "../../config";
import { safeParseJSON } from "../../util/json";
import { log } from "../../util/logger";
import { attempt } from "../../util/result";

/** OpenAI-compatible chat completions path appended to the hygiene base URL. */
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

const MERGE_SYSTEM_PROMPT = `You consolidate overlapping development memories into one.

You are given several short factual statements that describe the SAME thing in slightly different words or from slightly different angles. Fuse them into a SINGLE crisp memory that:
- preserves every distinct specific (numbers, names, file paths, decisions, reasons)
- drops only the redundancy between them
- invents NOTHING not present in the inputs
- reads as one standalone fact useful in a FUTURE conversation

Output ONLY the merged statement as plain text. No preamble, no quotes, no JSON, no bullet points.`;

const CLASSIFY_SYSTEM_PROMPT = `You compare two development memories that are close in topic and choose ONE action describing how they relate.

- "merge": they are about the SAME thing and should be fused into one memory with NO loss — either redundant restatements, or one updates/supersedes the other while BOTH still carry detail worth keeping (e.g. an earlier plan or phase plus its later completion; a decision plus its implementation; a status that moved forward). Fusing them keeps every fact and just reconciles the timeline.

- "demote": they make claims that CANNOT both be true — one directly negates, contradicts, or reports a different value than the other, and one is simply WRONG now (e.g. "X has 32GB" vs "X has 128GB"; "we use approach A" vs "A was abandoned for B"; "the fix is in place" vs "that fix was reverted"). Here we keep the correct statement and demote the wrong one. Do NOT pick merge for these — fusing a true claim with a false one would corrupt the record.

- "leave": anything else — they are about different things, or both are independently true and complementary, or you cannot confidently tell.

Decide merge vs demote with this test: if a reader could hold BOTH statements' facts in one coherent memory, choose "merge". If holding both would mean believing something now FALSE, choose "demote". When unsure between demote and leave, choose "leave". When unsure between merge and leave, choose "leave".

For "demote", set survivor to the statement that is correct/current (1 or 2); if you cannot tell which side is right, choose "leave" instead. For "merge" and "leave", survivor is null.

Respond with ONLY a JSON object — no preamble, no markdown fences:
{"action": "merge" | "demote" | "leave", "survivor": 1 | 2 | null, "reason": "<one short sentence>"}
survivor refers to statement 1 or statement 2 as labelled in the input.`;

interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string; reasoning_content?: string };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface HygieneModelConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

/** Resolve the hygiene model config, or null when HYGIENE_MODEL is unset. */
export function getHygieneModelConfig(): HygieneModelConfig | null {
  const { model, baseUrl, apiKey } = config.hygiene;
  if (!model) return null;
  const normalizedBase = baseUrl.replace(/\/v1$/, "");
  return { baseUrl: normalizedBase, apiKey, model };
}

/**
 * Ask the hygiene model to merge a cluster of memory contents into one
 * canonical statement. Returns the merged text, or null on failure (the caller
 * then leaves the cluster untouched rather than guessing).
 */
export async function mergeMemoriesText(
  contents: string[],
): Promise<string | null> {
  const cfg = getHygieneModelConfig();
  if (!cfg) {
    log.warn("HYGIENE_MODEL unset — cannot consolidate");
    return null;
  }

  const userContent = contents.map((c, i) => `${i + 1}. ${c}`).join("\n");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const [err, res] = await attempt(() =>
    fetch(`${cfg.baseUrl}${CHAT_COMPLETIONS_PATH}`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        temperature: 0.1,
        // Reasoning models (GLM-5.1) spend tokens thinking before they answer.
        // Too small a budget and the whole allowance goes to reasoning, leaving
        // `content` empty — so this is generous, the merged text itself is tiny.
        max_tokens: config.hygiene.maxTokens,
        messages: [
          { role: "system", content: MERGE_SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      }),
    }).then((r) => r.json() as Promise<ChatCompletionResponse>),
  );

  if (err) {
    log.error(
      { err, count: contents.length },
      "consolidation model call failed",
    );
    return null;
  }

  const choice = res.choices?.[0];
  const merged = choice?.message?.content?.trim();
  if (!merged) {
    // Surface WHY it's empty: finish_reason "length" = truncated (bump
    // max_tokens); reasoning present with empty content = same story.
    log.error(
      {
        finishReason: choice?.finish_reason,
        reasoningChars: choice?.message?.reasoning_content?.length ?? 0,
        completionTokens: res.usage?.completion_tokens,
        maxTokens: config.hygiene.maxTokens,
      },
      "consolidation model returned empty content",
    );
    return null;
  }

  log.debug(
    {
      inputs: contents.length,
      mergedChars: merged.length,
      promptTokens: res.usage?.prompt_tokens,
      completionTokens: res.usage?.completion_tokens,
    },
    "consolidation merge produced",
  );
  return merged;
}

/**
 * Pull a verdict out of the judge's text, tolerating markdown fences or stray
 * prose around the JSON. Returns null when no usable object is found. Coerces
 * loose shapes (string "true", string "1") into the typed verdict so a slightly
 * sloppy model response still counts.
 */
function parseVerdict(content: string) {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  const slice =
    start >= 0 && end > start ? content.slice(start, end + 1) : content;

  const parsed = safeParseJSON(slice);
  if (!parsed || typeof parsed !== "object") return null;
  if (!("action" in parsed)) return null;

  const a = parsed.action;
  const action: "merge" | "demote" | "leave" | null =
    a === "merge"
      ? "merge"
      : a === "demote"
        ? "demote"
        : a === "leave"
          ? "leave"
          : null;
  if (action === null) return null;

  const s = parsed.survivor;
  const survivor: 1 | 2 | null =
    s === 1 || s === "1" ? 1 : s === 2 || s === "2" ? 2 : null;
  const reason = typeof parsed.reason === "string" ? parsed.reason : "";
  return { action, survivor, reason };
}

/**
 * Ask the hygiene model how two close-in-topic memories relate: merge them
 * (same thing / lossless supersession), demote one (factual conflict, with the
 * surviving truth picked), or leave them alone. Returns the verdict, or null on
 * any failure (call error, empty content, unparseable response) — the caller
 * then leaves the pair alone rather than guessing, mirroring mergeMemoriesText.
 */
export async function classifyPair(a: string, b: string) {
  const cfg = getHygieneModelConfig();
  if (!cfg) {
    log.warn("HYGIENE_MODEL unset — cannot classify memory pairs");
    return null;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  const [err, res] = await attempt(() =>
    fetch(`${cfg.baseUrl}${CHAT_COMPLETIONS_PATH}`, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(120_000),
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        temperature: 0.1,
        max_tokens: config.hygiene.maxTokens,
        messages: [
          { role: "system", content: CLASSIFY_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Statement 1:\n${a}\n\nStatement 2:\n${b}`,
          },
        ],
      }),
    }).then((r) => r.json() as Promise<ChatCompletionResponse>),
  );

  if (err) {
    log.error({ err }, "pair classifier call failed");
    return null;
  }

  const choice = res.choices?.[0];
  const content = choice?.message?.content?.trim();
  if (!content) {
    log.error(
      {
        finishReason: choice?.finish_reason,
        reasoningChars: choice?.message?.reasoning_content?.length ?? 0,
        completionTokens: res.usage?.completion_tokens,
        maxTokens: config.hygiene.maxTokens,
      },
      "pair classifier returned empty content",
    );
    return null;
  }

  const verdict = parseVerdict(content);
  if (!verdict) {
    log.error(
      { content: content.slice(0, 200) },
      "pair classifier returned unparseable verdict",
    );
    return null;
  }

  log.debug(
    { action: verdict.action, survivor: verdict.survivor },
    "pair classified",
  );
  return verdict;
}
