import { createEmbedQuery } from "@mimir/plugin-core/brain/embedder";
import type { EmbedQuery } from "@mimir/plugin-core/brain/retrieve";
import type { OrgReplica } from "@mimir/plugin-core/store/org-replica";
import {
  executeOrgMemoryTool,
  orgMemoryToolDefs,
} from "@mimir/plugin-core/tools/org-memory";
import { tool } from "@opencode-ai/plugin";

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
        query: tool.schema.string().describe("Search query"),
        limit: tool.schema
          .number()
          .optional()
          .describe("Maximum results (default: 10)"),
      },
      execute: (args) => execute("project_memory_search", args),
    }),

    project_memory_store: tool({
      description: description("project_memory_store"),
      args: {
        content: tool.schema.string().describe("The fact to remember"),
        project: tool.schema
          .string()
          .optional()
          .describe("Optional project identifier"),
      },
      execute: (args) => execute("project_memory_store", args),
    }),

    project_memory_update: tool({
      description: description("project_memory_update"),
      args: {
        id: tool.schema.string().describe("Memory ID to update"),
        content: tool.schema.string().describe("New memory content"),
      },
      execute: (args) => execute("project_memory_update", args),
    }),

    project_memory_list: tool({
      description: description("project_memory_list"),
      args: {
        limit: tool.schema
          .number()
          .optional()
          .describe("Maximum memories (default: 20)"),
      },
      execute: (args) => execute("project_memory_list", args),
    }),

    project_memory_delete: tool({
      description: description("project_memory_delete"),
      args: {
        id: tool.schema.string().describe("Memory ID to delete"),
      },
      execute: (args) => execute("project_memory_delete", args),
    }),

    project_playbook_store: tool({
      description: description("project_playbook_store"),
      args: {
        name: tool.schema.string().describe("Short playbook label"),
        trigger: tool.schema.string().describe("When the playbook applies"),
        content: tool.schema.string().describe("The playbook body"),
        project: tool.schema
          .string()
          .optional()
          .describe("Optional project identifier"),
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
        name: tool.schema.string().optional().describe("Playbook name"),
        id: tool.schema.string().optional().describe("Playbook memory ID"),
      },
      execute: (args) => execute("project_playbook_load", args),
    }),

    project_playbook_update: tool({
      description: description("project_playbook_update"),
      args: {
        name: tool.schema.string().optional().describe("Current playbook name"),
        id: tool.schema.string().optional().describe("Playbook memory ID"),
        newName: tool.schema.string().optional().describe("New playbook name"),
        trigger: tool.schema.string().optional().describe("New trigger"),
        content: tool.schema.string().optional().describe("New playbook body"),
      },
      execute: (args) => execute("project_playbook_update", args),
    }),

    project_playbook_delete: tool({
      description: description("project_playbook_delete"),
      args: {
        name: tool.schema.string().optional().describe("Playbook name"),
        id: tool.schema.string().optional().describe("Playbook memory ID"),
      },
      execute: (args) => execute("project_playbook_delete", args),
    }),
  };
};
