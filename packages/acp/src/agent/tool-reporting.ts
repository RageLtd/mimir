/**
 * Tool call ACP reporting helpers.
 *
 * Maps tool names to ACP kinds, extracts file locations from tool args,
 * and builds rich tool call content (diffs) for the editor.
 */

import type * as acp from "@agentclientprotocol/sdk";

// ── Tool kind mapping ──

const TOOL_KIND_MAP: Record<string, acp.ToolKind> = {
  // Client FS tools
  fs_read_text_file: "read",
  read_text_file: "read",
  fs_write_text_file: "edit",
  write_text_file: "edit",
  // Client terminal tools
  create_terminal: "execute",
  terminal: "execute",
  // CC tools (observed)
  Read: "read",
  Write: "edit",
  Edit: "edit",
  Bash: "execute",
  Glob: "search",
  Grep: "search",
  WebFetch: "fetch",
  WebSearch: "fetch",
  TodoWrite: "other",
  // Server tools (project-scoped memory via Goldfish)
  project_memory_search: "search",
  project_memory_store: "other",
  project_memory_update: "other",
  project_memory_list: "read",
  project_memory_delete: "delete",
  cartographer_search: "search",
  cartographer_file_info: "read",
  cartographer_query: "search",
  web_search: "fetch",
  // Local user memory tools
  user_memory_search: "search",
  user_memory_store: "other",
  user_memory_list: "read",
  user_memory_delete: "delete",
  // Local user profile tools
  user_profile_get: "read",
  user_profile_add: "other",
  user_profile_remove: "delete",
};

export const toolKindFor = (name: string): acp.ToolKind =>
  TOOL_KIND_MAP[name] ?? "other";

// ── Title extraction ──

/** Build a human-readable title for a tool call. */
export const toolTitle = (name: string, args: Record<string, unknown>) => {
  if (name === "Bash") {
    if (typeof args.description === "string" && args.description.length > 0)
      return args.description;
    if (typeof args.command === "string" && args.command.length > 0)
      return args.command.length > 80
        ? `${args.command.slice(0, 77)}...`
        : args.command;
  }
  if (name === "Read" && typeof args.file_path === "string")
    return `Read ${args.file_path}`;
  if (name === "Edit" && typeof args.file_path === "string")
    return `Edit ${args.file_path}`;
  if (name === "Write" && typeof args.file_path === "string")
    return `Write ${args.file_path}`;
  if (name === "Grep" && typeof args.pattern === "string")
    return `Grep: ${args.pattern}`;
  if (name === "Glob" && typeof args.pattern === "string")
    return `Glob: ${args.pattern}`;
  return name;
};

// ── Location extraction ──

/** Extract file locations from tool call args for editor follow-along. */
export const extractLocations = (
  _name: string,
  args: Record<string, unknown>,
): acp.ToolCallLocation[] | undefined => {
  const path = args.path ?? args.file_path ?? args.filePath;
  if (typeof path !== "string") return undefined;
  const line =
    typeof args.line === "number"
      ? args.line
      : typeof args.offset === "number"
        ? args.offset
        : undefined;
  return [{ path, ...(line !== undefined ? { line } : {}) }];
};

// ── Diff content builders ──

/** Build rich tool call content (diffs, terminal output) for tool results. */
export const buildToolCallContent = (
  name: string,
  args: Record<string, unknown>,
  result: string,
): acp.ToolCallContent[] | undefined => {
  // Write operations → diff content
  if (
    name === "fs_write_text_file" ||
    name === "write_text_file" ||
    name === "Write"
  ) {
    const path = (args.path ?? args.file_path) as string | undefined;
    if (path && typeof args.content === "string") {
      return [
        {
          type: "diff",
          path,
          oldText: null,
          newText: args.content as string,
        },
      ];
    }
  }

  // Edit operations → diff content (old_string → new_string)
  if (name === "Edit") {
    const path = (args.file_path ?? args.path) as string | undefined;
    if (path) {
      return [
        {
          type: "diff",
          path,
          oldText: (args.old_string as string) ?? null,
          newText: (args.new_string as string) ?? "",
        },
      ];
    }
  }

  // Bash / terminal tools → console code block (matches Zed's fallback format).
  // Used when the client doesn't support terminal_output _meta; the terminal
  // path is handled directly in prompt-cc.ts via _meta events.
  if (name === "Bash" || name === "create_terminal" || name === "terminal") {
    const output = result.trim();
    if (output.length > 0) {
      return [
        {
          type: "content",
          content: {
            type: "text",
            text: `\`\`\`console\n${output}\n\`\`\``,
          },
        },
      ];
    }
  }

  // Read tools → surface file contents as text
  if (
    name === "Read" ||
    name === "fs_read_text_file" ||
    name === "read_text_file"
  ) {
    if (result.length > 0) {
      return [{ type: "content", content: { type: "text", text: result } }];
    }
  }

  // Search / fetch tools → surface results as text
  if (
    name === "Glob" ||
    name === "Grep" ||
    name === "WebFetch" ||
    name === "WebSearch" ||
    name === "web_search"
  ) {
    if (result.length > 0) {
      return [{ type: "content", content: { type: "text", text: result } }];
    }
  }

  return undefined;
};

// ── Client tool classification ──

const CLIENT_FS_TOOLS = new Set([
  "fs_read_text_file",
  "fs_write_text_file",
  "read_text_file",
  "write_text_file",
]);

const CLIENT_TERMINAL_TOOLS = new Set(["create_terminal", "terminal"]);

export const isClientTool = (name: string) =>
  CLIENT_FS_TOOLS.has(name) || CLIENT_TERMINAL_TOOLS.has(name);
