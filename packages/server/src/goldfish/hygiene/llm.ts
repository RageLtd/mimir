/**
 * Hygiene model client — routes consolidation judgment to a deliberately
 * capable model (GLM-5.1 over opencode-go by default), separate from the small
 * Vulkan-bound extraction model.
 *
 * Env-only by design: if HYGIENE_MODEL is unset, getHygieneModelConfig returns
 * null and the sweep refuses to run rather than silently merging memories with
 * whatever model happens to be configured elsewhere.
 */

import { runOverrideCompletion } from "../../agent/provider/override-completion";
import { config } from "../../config";
import type { ProviderOverride } from "../../middleware/types";
import { safeParseJSON } from "../../util/json";
import { log } from "../../util/logger";
import { attempt } from "../../util/result";

/** OpenAI-compatible chat completions path appended to the hygiene base URL. */
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

/** Deadline for a single hygiene model call — reasoning models spend a while
 *  thinking before the (tiny) answer, so this is generous. */
const HYGIENE_CALL_TIMEOUT_MS = 120_000;

/**
 * BYOK context for a manually-triggered sweep (MIM-75 Part 1): the caller's
 * transient provider key plus their explicitly named judgment model. Transient
 * — held for the sweep only, never persisted. Absent → the env HYGIENE_MODEL
 * path serves as before. MIM-74's hard rule applies: a keyed call that fails
 * returns null and must NEVER fall back to operator-funded inference.
 */
export type HygieneByok = {
  readonly override: ProviderOverride;
  readonly modelId: string;
};

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
 * One env-configured hygiene model call: system+user in, content string out,
 * null on any failure (call error, empty content) with the diagnostics logged.
 * Shared by merge and classify so the transport can't drift between them.
 */
async function completeWithEnvModel(opts: {
  system: string;
  user: string;
  label: string;
}) {
  const cfg = getHygieneModelConfig();
  if (!cfg) {
    log.warn({ label: opts.label }, "HYGIENE_MODEL unset — cannot run");
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
      signal: AbortSignal.timeout(HYGIENE_CALL_TIMEOUT_MS),
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        temperature: 0.1,
        // Reasoning models (GLM-5.1) spend tokens thinking before they answer.
        // Too small a budget and the whole allowance goes to reasoning, leaving
        // `content` empty — so this is generous, the answer itself is tiny.
        max_tokens: config.hygiene.maxTokens,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
      }),
    }).then((r) => r.json() as Promise<ChatCompletionResponse>),
  );

  if (err) {
    log.error({ err, label: opts.label }, "hygiene model call failed");
    return null;
  }

  const choice = res.choices?.[0];
  const content = choice?.message?.content?.trim();
  if (!content) {
    // Surface WHY it's empty: finish_reason "length" = truncated (bump
    // max_tokens); reasoning present with empty content = same story.
    log.error(
      {
        label: opts.label,
        finishReason: choice?.finish_reason,
        reasoningChars: choice?.message?.reasoning_content?.length ?? 0,
        completionTokens: res.usage?.completion_tokens,
        maxTokens: config.hygiene.maxTokens,
      },
      "hygiene model returned empty content",
    );
    return null;
  }
  return content;
}

/**
 * One hygiene model completion, routed by key presence: a BYOK sweep runs on
 * the caller's key and named model via runOverrideCompletion (keyed failure →
 * null, never the env path); a keyless sweep uses the env HYGIENE_MODEL
 * transport unchanged.
 */
async function completeHygiene(opts: {
  system: string;
  user: string;
  label: string;
  byok?: HygieneByok | null;
}) {
  if (opts.byok) {
    return runOverrideCompletion({
      system: opts.system,
      user: opts.user,
      maxOutputTokens: config.hygiene.maxTokens,
      timeoutMs: HYGIENE_CALL_TIMEOUT_MS,
      modelId: opts.byok.modelId,
      override: opts.byok.override,
    });
  }
  return completeWithEnvModel(opts);
}

/**
 * Ask the hygiene model to merge a cluster of memory contents into one
 * canonical statement. Returns the merged text, or null on failure (the caller
 * then leaves the cluster untouched rather than guessing).
 */
export async function mergeMemoriesText(
  contents: string[],
  byok?: HygieneByok | null,
) {
  const userContent = contents.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const merged = await completeHygiene({
    system: MERGE_SYSTEM_PROMPT,
    user: userContent,
    label: "consolidation merge",
    byok,
  });
  if (!merged) return null;

  log.debug(
    { inputs: contents.length, mergedChars: merged.length, byok: !!byok },
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
export async function classifyPair(
  a: string,
  b: string,
  byok?: HygieneByok | null,
) {
  const content = await completeHygiene({
    system: CLASSIFY_SYSTEM_PROMPT,
    user: `Statement 1:\n${a}\n\nStatement 2:\n${b}`,
    label: "pair classifier",
    byok,
  });
  if (!content) return null;

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
