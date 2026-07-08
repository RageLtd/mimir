/**
 * Tool definitions for the local project-memory + playbook tools (MIM-84).
 * Names, parameter schemas, and descriptions mirror the server's /mcp
 * versions (agent/server-tools/memory.ts + playbook.ts) so the model's
 * habits carry over unchanged. Executor lives in org-memory.ts.
 */

import type { ToolDefinition } from "./user-memory";

export const orgMemoryToolDefs: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "project_memory_search",
      description:
        "Search memories scoped to the current project — past architectural decisions, naming conventions, session summaries, pending work, and the reasoning behind choices already made in THIS codebase. Use when starting a task and needing cross-session context about the project, when the developer references a past decision, when a pattern looks deliberate and you want to know why, or when encountering unfamiliar code that may have recorded context. This is project-scoped knowledge, not facts about the developer themselves — use user_memory_search for that.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query — keywords or natural language question",
          },
          limit: {
            type: "number",
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
      name: "project_memory_store",
      description:
        "Persist a project-scoped fact to cross-session memory. Use when an architectural decision is made, a non-obvious convention is established, a session reaches a good stopping point and its outcome should survive, or a piece of reasoning about THIS codebase would be valuable to future sessions. Scope is the current project — facts about the developer themselves (preferences, identity, setup) belong in user_memory_store instead.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "The fact to remember — single, self-contained statement",
          },
          project: {
            type: "string",
            description:
              "Project identifier (canonical UUID preferred; stored as given).",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "project_memory_update",
      description:
        "Update the content of an existing project memory by ID. Use when a stored project memory is now wrong or superseded — prefer updating over storing a duplicate. Find the target ID via project_memory_search or project_memory_list.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Memory ID to update (e.g. 'memory:abc123')",
          },
          content: {
            type: "string",
            description: "New content for this memory",
          },
        },
        required: ["id", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "project_memory_list",
      description:
        "List project memories in recency order. Use to review what's been persisted for this project, find the ID of a specific memory for update or deletion, or audit the current knowledge base when context is scarce.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum memories (default: 20)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "project_memory_delete",
      description:
        "Delete a project memory by ID. Confirm the content with the developer before calling — memories are the persistent project record and removal should be deliberate.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Memory ID to delete" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "project_playbook_store",
      description:
        "Persist a learned, reusable playbook — the procedure for a recurring KIND of task — so future sessions follow it instead of rediscovering it. Give it a name, a 'use this when…' trigger describing when it applies, and the step-by-step body. The trigger decides when the body auto-loads, so describe the situation, not the steps. For one-off facts ABOUT this codebase use project_memory_store; for facts about the developer use user_memory_store.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Short label for the playbook — how it appears in the always-present index.",
          },
          trigger: {
            type: "string",
            description:
              "The 'use this when…' line describing WHEN the playbook applies.",
          },
          content: {
            type: "string",
            description:
              "The playbook body — steps, checks, sequence, and gotchas.",
          },
          project: {
            type: "string",
            description:
              "Optional project identifier when the procedure is repo-specific.",
          },
        },
        required: ["name", "trigger", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "project_playbook_list",
      description:
        "List stored playbooks with their names, triggers, and ids. Use to see the full library or find a playbook's id for update/delete.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "project_playbook_load",
      description:
        "Load a playbook's full body by name (as shown in the index) or id.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Playbook name to load." },
          id: { type: "string", description: "Playbook memory id, if known." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "project_playbook_update",
      description:
        "Edit an existing playbook by name or id — rename it (newName), refine its trigger, or revise its body (content). Prefer updating over storing a near-duplicate.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Selector: playbook name." },
          id: { type: "string", description: "Selector: memory id." },
          newName: { type: "string", description: "New name." },
          trigger: { type: "string", description: "New trigger line." },
          content: { type: "string", description: "New body." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "project_playbook_delete",
      description:
        "Delete a playbook by name or id. Confirm with the developer before calling.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Selector: playbook name." },
          id: { type: "string", description: "Selector: memory id." },
        },
      },
    },
  },
];

export const orgMemoryToolNames = new Set(
  orgMemoryToolDefs.map((t) => t.function.name),
);
