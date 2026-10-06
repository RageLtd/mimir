import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import type { EmbedQuery } from "@mimir/plugin-core/brain/retrieve";
import type { OrgReplica } from "@mimir/plugin-core/store/org-replica";
import {
  executeOrgMemoryTool,
  orgMemoryToolDefs,
} from "@mimir/plugin-core/tools/org-memory";
import { tool } from "./tool-factory";

const description = (name: string) =>
  orgMemoryToolDefs.find((def) => def.function.name === name)?.function
    .description ?? "";

export const orgMemoryTools = (
  replica: OrgReplica | null,
  embedQuery: EmbedQuery = createEmbedQuery(),
) => {
  const execute = async (name: string, args: Record<string, unknown>) => {
    if (!replica) {
      return "Project memory unavailable: local replica not initialised.";
    }
    const result = await executeOrgMemoryTool(replica, name, args, embedQuery);
    return result.isError ? `Error: ${result.content}` : result.content;
  };

  return {
    project_memory_search: tool({
      description: description("project_memory_search"),
      args: {
        query: { type: "string", description: "Search query" },
        limit: {
          type: "number",
          description: "Maximum results (default: 10)",
          optional: true,
        },
      },
      execute: (args) => execute("project_memory_search", args),
    }),

    project_memory_store: tool({
      description: description("project_memory_store"),
      args: {
        content: { type: "string", description: "The fact to remember" },
        project: {
          type: "string",
          description: "Optional project identifier",
          optional: true,
        },
      },
      execute: (args) => execute("project_memory_store", args),
    }),

    project_memory_update: tool({
      description: description("project_memory_update"),
      args: {
        id: { type: "string", description: "Memory ID to update" },
        content: { type: "string", description: "New memory content" },
      },
      execute: (args) => execute("project_memory_update", args),
    }),

    project_memory_list: tool({
      description: description("project_memory_list"),
      args: {
        limit: {
          type: "number",
          description: "Maximum memories (default: 20)",
          optional: true,
        },
      },
      execute: (args) => execute("project_memory_list", args),
    }),

    project_memory_delete: tool({
      description: description("project_memory_delete"),
      args: {
        id: { type: "string", description: "Memory ID to delete" },
      },
      execute: (args) => execute("project_memory_delete", args),
    }),

    project_playbook_store: tool({
      description: description("project_playbook_store"),
      args: {
        name: { type: "string", description: "Short playbook label" },
        trigger: { type: "string", description: "When the playbook applies" },
        content: { type: "string", description: "The playbook body" },
        project: {
          type: "string",
          description: "Optional project identifier",
          optional: true,
        },
      },
      execute: (args) => execute("project_playbook_store", args),
    }),

    project_playbook_list: tool({
      description: description("project_playbook_list"),
      args: {},
      execute: (args) => execute("project_playbook_list", args),
    }),

    project_playbook_load: tool({
      description: description("project_playbook_load"),
      args: {
        name: { type: "string", description: "Playbook name", optional: true },
        id: {
          type: "string",
          description: "Playbook memory ID",
          optional: true,
        },
      },
      execute: (args) => execute("project_playbook_load", args),
    }),

    project_playbook_update: tool({
      description: description("project_playbook_update"),
      args: {
        name: {
          type: "string",
          description: "Current playbook name",
          optional: true,
        },
        id: {
          type: "string",
          description: "Playbook memory ID",
          optional: true,
        },
        newName: {
          type: "string",
          description: "New playbook name",
          optional: true,
        },
        trigger: { type: "string", description: "New trigger", optional: true },
        content: {
          type: "string",
          description: "New playbook body",
          optional: true,
        },
      },
      execute: (args) => execute("project_playbook_update", args),
    }),

    project_playbook_delete: tool({
      description: description("project_playbook_delete"),
      args: {
        name: { type: "string", description: "Playbook name", optional: true },
        id: {
          type: "string",
          description: "Playbook memory ID",
          optional: true,
        },
      },
      execute: (args) => execute("project_playbook_delete", args),
    }),
  };
};
