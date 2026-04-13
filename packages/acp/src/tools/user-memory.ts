/**
 * Local user memory tools.
 *
 * These tools appear in the model's tool manifest alongside server tools
 * and client tools. When the model calls one, mimir-acp intercepts it
 * before it reaches the server, executes it locally against bun:sqlite,
 * and sends the result back to the server for the next turn.
 *
 * Flat text entries, no category/key structure — matching the plan.
 */

import type { ToolDefinition } from "../server-client";
import type { UserMemoryStore } from "../store/user-memories";

export type ToolResult = {
  readonly content: string;
  readonly isError?: boolean;
};

export const userMemoryToolDefs: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "user_memory_search",
      description:
        "Search the user's personal memories using full-text search. Use this to find facts about the user's preferences, background, or past interactions.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query to match against stored memories",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "user_memory_store",
      description:
        "Store a new personal memory about the user. Use this when you learn something about the user that should persist across conversations.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The fact or preference to remember",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "user_memory_list",
      description:
        "List all stored user memories. Use this to get an overview of what is known about the user.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "user_memory_delete",
      description:
        "Delete a user memory by ID. Use this when a memory is no longer accurate or relevant.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "integer",
            description: "The ID of the memory to delete",
          },
        },
        required: ["id"],
      },
    },
  },
];

export const userMemoryToolNames = new Set(
  userMemoryToolDefs.map((t) => t.function.name),
);

const formatMemoryEntry = (entry: {
  readonly id: number;
  readonly content: string;
}): string => `[${entry.id}] ${entry.content}`;

export const executeUserMemoryTool = (
  store: UserMemoryStore,
  name: string,
  args: Record<string, unknown>,
): ToolResult => {
  switch (name) {
    case "user_memory_search": {
      const query = args.query as string;
      const results = store.searchMemories(query);
      if (results.length === 0) {
        return { content: "No matching memories found." };
      }
      return { content: results.map(formatMemoryEntry).join("\n") };
    }

    case "user_memory_store": {
      const content = args.content as string;
      const entry = store.addMemory(content);
      return {
        content: `Memory stored with ID ${entry.id}: "${entry.content}"`,
      };
    }

    case "user_memory_list": {
      const memories = store.getMemories();
      if (memories.length === 0) {
        return { content: "No memories stored yet." };
      }
      return { content: memories.map(formatMemoryEntry).join("\n") };
    }

    case "user_memory_delete": {
      const id = args.id as number;
      const deleted = store.deleteMemory(id);
      return deleted
        ? { content: `Memory ${id} deleted.` }
        : { content: `Memory ${id} not found.`, isError: true };
    }

    default:
      return { content: `Unknown tool: ${name}`, isError: true };
  }
};
