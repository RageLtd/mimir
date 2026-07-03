import { tool } from "ai";
import { z } from "zod";
import { log } from "../../util/logger";
import { CACHE_CONTROL } from "./shared";

// ---------------------------------------------------------------------------
// Schema — mirrors Claude Code's TodoWrite so a CC-trained model produces
// valid calls. activeForm is optional (lenient) since the execute is a no-op.
// ---------------------------------------------------------------------------

export const TodoWriteSchema = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().describe("Imperative description of the task"),
        status: z
          .enum(["pending", "in_progress", "completed"])
          .describe("Current state of this task"),
        activeForm: z
          .string()
          .optional()
          .describe("Present-tense form shown while the task is in progress"),
      }),
    )
    .describe("The complete todo list — replaces any prior list for this turn"),
});

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

// TodoWrite has no server-side state: the plan lives in the editor's plan
// panel, which the ACP adapter renders from the tool observation's input.
// The execute only acknowledges so the agent loop keeps going — a client tool
// would halt the loop, whereas a recorded plan should let the model continue.
export const executeTodoWrite = async ({
  todos,
}: z.infer<typeof TodoWriteSchema>) => {
  log.info({ count: todos.length }, "TodoWrite");
  return `Plan recorded: ${todos.length} item${todos.length === 1 ? "" : "s"}.`;
};

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const planTools = {
  TodoWrite: tool({
    description:
      "Record or update the task plan for a multi-step job. Surfaces in the editor's plan panel. Call it when starting work that has several steps, and again as items move to in_progress and completed. Always send the COMPLETE list — it replaces the previous one. Skip it for trivial single-step work.",
    inputSchema: TodoWriteSchema,
    providerOptions: CACHE_CONTROL,
    execute: executeTodoWrite,
  }),
};
