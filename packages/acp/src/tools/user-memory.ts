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
        "Store a new personal memory about the user. Call this proactively whenever the developer reveals something about themselves — preferences, opinions, life circumstances, health conditions, frustrations, personal history, technical decisions, or anything else worth remembering. No explicit 'remember this' required; if it's worth knowing next session, store it now.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "The fact to remember — a single, self-contained statement (e.g. 'Has ADHD', 'Frustrated with current employer', 'Prefers dark themes', 'Partner is pregnant')",
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
  {
    type: "function",
    function: {
      name: "user_profile_get",
      description:
        "Get the user's profile — structured facts like name, role, preferences, and communication style. Returns all profile entries.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "user_profile_add",
      description:
        "Add an entry to the user's profile. Use for stable identity facts: name, role, location, health conditions, communication preferences, editor/tool setup, household details, hobbies, philosophical outlook — anything that defines who the developer is rather than what happened in a specific session.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "The profile fact to store (e.g. 'Name: Alex', 'Has ADHD — prefers direct communication', 'HEMA practitioner', 'Lives in Vancouver with partner and dog')",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "user_profile_remove",
      description:
        "Remove a profile entry by ID. Use when a profile fact is outdated or wrong.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "integer",
            description: "The ID of the profile entry to remove",
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
}) => `[${entry.id}] ${entry.content}`;

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

    case "user_profile_get": {
      const entries = store.getProfile();
      if (entries.length === 0) {
        return { content: "No profile entries yet." };
      }
      return {
        content: entries.map((e) => `[${e.id}] ${e.content}`).join("\n"),
      };
    }

    case "user_profile_add": {
      const content = args.content as string;
      const entry = store.addProfileEntry(content);
      return {
        content: `Profile entry stored with ID ${entry.id}: "${entry.content}"`,
      };
    }

    case "user_profile_remove": {
      const id = args.id as number;
      const removed = store.removeProfileEntry(id);
      return removed
        ? { content: `Profile entry ${id} removed.` }
        : { content: `Profile entry ${id} not found.`, isError: true };
    }

    default:
      return { content: `Unknown tool: ${name}`, isError: true };
  }
};

/**
 * Build a <user_context> XML block from profile + recent memories.
 * Returns null if the user has no profile and no memories.
 */
export const buildUserContext = (store: UserMemoryStore) => {
  const profile = store.getProfileAsText();
  const memories = store.getMemories();

  if (!profile && memories.length === 0) return null;

  const parts: string[] = ["<user_context>"];

  if (profile) {
    parts.push("<user_profile>");
    parts.push(profile);
    parts.push("</user_profile>");
  }

  if (memories.length > 0) {
    parts.push("<user_memories>");
    parts.push(memories.map(formatMemoryEntry).join("\n"));
    parts.push("</user_memories>");
  }

  parts.push("</user_context>");
  return parts.join("\n");
};
