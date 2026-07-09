/**
 * Turn-context assembly helpers for the local agent loop (MIM-89).
 *
 * Owns the pieces prompt-server composes before invoking the backend:
 * the synthetic context-injection pair (local successor to the server's
 * buildContextInjection) and the local TodoWrite tool definition + input
 * parsing for plan-panel rendering.
 */

import type { ToolDefinition } from "@mimir/plugin-core/tools/user-memory";
import type { ChatMessage } from "./types";

/**
 * Local TodoWrite — schema mirrors Claude Code's TodoWrite (ported from
 * the dead server plan tool) so a CC-trained model produces valid calls.
 * Execution renders the editor's plan panel; no state is kept.
 */
export const todoWriteToolDef: ToolDefinition = {
  type: "function",
  function: {
    name: "TodoWrite",
    description:
      "Record or update the task plan for a multi-step job. Surfaces in the editor's plan panel. Call it when starting work that has several steps, and again as items move to in_progress and completed. Always send the COMPLETE list — it replaces the previous one. Skip it for trivial single-step work.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          description:
            "The complete todo list — replaces any prior list for this turn",
          items: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description: "Imperative description of the task",
              },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "Current state of this task",
              },
              activeForm: {
                type: "string",
                description:
                  "Present-tense form shown while the task is in progress",
              },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["todos"],
    },
  },
};

/**
 * Narrow one raw todo entry to the shape emitPlanUpdate renders, without
 * casts — `in` checks narrow the unknown object property-by-property.
 * Returns null for malformed entries.
 */
const parseTodoEntry = (t: unknown) => {
  if (typeof t !== "object" || t === null) return null;
  if (!("content" in t) || !("status" in t)) return null;
  if (typeof t.content !== "string" || typeof t.status !== "string")
    return null;
  const activeForm =
    "activeForm" in t && typeof t.activeForm === "string"
      ? t.activeForm
      : undefined;
  return {
    content: t.content,
    status: t.status,
    ...(activeForm ? { activeForm } : {}),
  };
};

/**
 * Parse a TodoWrite `todos` input into renderable entries. Lenient like
 * the old observe path: malformed entries are dropped, a non-array yields
 * null so the caller can report the call as invalid.
 */
export const parseTodos = (v: unknown) => {
  if (!Array.isArray(v)) return null;
  return v.flatMap((t) => {
    const entry = parseTodoEntry(t);
    return entry ? [entry] : [];
  });
};

/**
 * Compose the synthetic context injection pair — the local successor to
 * the server's buildContextInjection, same "Session context / Understood."
 * format. Returns [] when there is nothing to inject. The pair is
 * prepended to the backend's message array per turn and NEVER persisted
 * into session.messages.
 */
export const buildLocalContextInjection = (
  contextBlock: string,
  userContext: string | null,
  projectRules: string | null,
) => {
  const parts: string[] = [];
  if (contextBlock) parts.push(contextBlock);
  if (userContext) parts.push(userContext);
  if (projectRules)
    parts.push(`<project_rules>\n${projectRules}\n</project_rules>`);
  if (parts.length === 0) return [] as ChatMessage[];
  return [
    {
      role: "user" as const,
      content: `Session context:\n${parts.join("\n\n")}`,
    },
    { role: "assistant" as const, content: "Understood." },
  ] satisfies ChatMessage[];
};
