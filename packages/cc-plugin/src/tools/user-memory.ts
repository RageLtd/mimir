/**
 * User-memory tool definitions and execution logic. Ported from
 * packages/acp/src/tools/user-memory.ts.
 *
 * The ACP version imports `ToolDefinition` from server-client.ts (chat
 * completion shape with `function` envelope). We don't carry that
 * dependency in the plugin, so the tool definitions are inlined here in
 * the same OpenAI-style shape — the MCP server converts to MCP's
 * `{name, description, inputSchema}` form at serve time.
 */

import type { UserMemoryStore } from "../store/user-memories";

export type ToolDefinition = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: Record<string, unknown>;
  };
};

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
        "Search facts about the developer themselves — preferences, setup, opinions, life circumstances, past decisions they've made, frustrations. Use when the developer mentions something about their workflow, environment, or history that might have context worth recalling, when a preference they've expressed before seems relevant to the current task, or when you want to check whether you already know something about them before asking. This store is user-scoped across all projects — use project_memory_search for facts about the current codebase instead.",
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
        "Store a new fact about the developer. Call proactively whenever they reveal something about themselves — preferences, opinions, life circumstances, health conditions, frustrations, personal history, technical decisions, or anything worth remembering next session. No explicit 'remember this' required; if it's worth knowing across future sessions, store it now. User-scoped across all projects — facts about the current codebase belong in project_memory_store instead.",
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
        "List all stored facts about the developer. Use to get an overview of what is known about them, find the ID of a specific memory for update or deletion, or audit the store when context is thin.",
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
        "Delete a developer memory by ID. Use when a stored fact is no longer accurate, has been superseded, or the developer asks you to forget it. Confirm the content with them before calling unless they explicitly requested deletion.",
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
        "Get the developer's profile — stable identity facts like name, role, location, editor, communication preferences. Use when you need to reference their setup or preferences and the ambient <user_context> block isn't sufficient.",
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
        "Add an entry to the developer's profile. Use for stable identity facts: name, role, location, health conditions, communication preferences, editor/tool setup, household details, hobbies, philosophical outlook — anything that defines who they are rather than what happened in a specific session. Ephemeral facts belong in user_memory_store instead.",
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
        "Remove a profile entry by ID. Use when a profile fact is outdated, wrong, or the developer corrects it. Find the target ID via user_profile_get.",
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
