/**
 * Tools Manifest Endpoint
 *
 * GET /v1/tools
 *
 * Returns the list of server-side tools available to the agent.
 * mimir-acp fetches this to build its ACP tool manifest, combining
 * server tools + client tools + local user memory tools.
 *
 * This is a static manifest — tool definitions don't change at runtime.
 * The tools are executed by the agent loop in src/agent-loop/.
 */

import { Hono } from "hono";

export const tools = new Hono();

/**
 * OpenAI-compatible tool definition.
 * Matches the ToolDefinition type from mimir-acp.
 */
type ToolDef = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
};

/**
 * Server-side tool definitions.
 * These are executed by the agent loop, not forwarded to the client.
 */
const SERVER_TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "goldfish_search",
      description:
        "Search long-term conversation memories. Use this to find relevant context from past conversations, user preferences, or project knowledge that was explicitly stored.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query to match against stored memories",
          },
          limit: {
            type: "integer",
            description: "Maximum number of results to return (default: 5)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "goldfish_store",
      description:
        "Store information in long-term memory for future conversations. Use this when the user explicitly asks to remember something, or when you learn important context that should persist.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The information to store in memory",
          },
          category: {
            type: "string",
            description:
              "Optional category: 'preference', 'project', 'personal', 'technical', etc.",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cartographer_search",
      description:
        "Search the codebase index for files, symbols, or imports. Use this to find where something is defined, what files import a module, or locate code by symbol name.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query — matches file paths and symbol names",
          },
          limit: {
            type: "integer",
            description: "Maximum number of results (default: 10)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cartographer_file_info",
      description:
        "Get detailed information about a specific file: symbols, imports, and dependents. Use this to understand a file's role in the codebase.",
      parameters: {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Path to the file to analyze",
          },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cartographer_query",
      description:
        "Walk the import graph from entry points. Returns dependencies and dependents up to a specified depth. Use this to understand code relationships and impact analysis.",
      parameters: {
        type: "object",
        properties: {
          entry_points: {
            type: "array",
            items: { type: "string" },
            description: "File paths or symbol names to start from",
          },
          max_depth: {
            type: "integer",
            description: "Maximum hops to traverse (default: 2)",
          },
          max_results: {
            type: "integer",
            description: "Maximum files to return (default: 20)",
          },
        },
        required: ["entry_points"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_search",
      description:
        "Search conversation-level memories (Goldfish). These are facts extracted from past conversations, not user profile facts.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
          limit: {
            type: "integer",
            description: "Maximum results (default: 10)",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "memory_store",
      description:
        "Store a fact in conversation-level memory (Goldfish). This memory is tied to the current conversation context.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The fact to remember",
          },
        },
        required: ["content"],
      },
    },
  },
];

/**
 * GET /v1/tools
 *
 * Returns the server tool manifest.
 */
tools.get("/", (c) => {
  return c.json(SERVER_TOOLS);
});

/**
 * GET /v1/tools/:name
 *
 * Returns a specific tool definition by name.
 */
tools.get("/:name", (c) => {
  const name = c.req.param("name");
  const tool = SERVER_TOOLS.find((t) => t.function.name === name);

  if (!tool) {
    return c.json({ error: `Tool not found: ${name}` }, 404);
  }

  return c.json(tool);
});
