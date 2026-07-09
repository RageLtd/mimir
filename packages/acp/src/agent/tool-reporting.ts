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
  fs_edit_text_file: "edit",
  edit_file: "edit",
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
  project_playbook_store: "other",
  project_memory_update: "other",
  project_memory_list: "read",
  project_memory_delete: "delete",
  cartographer_search: "search",
  cartographer_file_info: "read",
  cartographer_query: "search",
  read_mimir_logs: "read",
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

export const toolKindFor = (name: string) => TOOL_KIND_MAP[name] ?? "other";

// ── Title extraction ──

/** Build a human-readable title for a tool call. */
export const toolTitle = (name: string, args: Record<string, unknown>) => {
  if (name === "Bash" || name === "create_terminal" || name === "terminal") {
    if (typeof args.description === "string" && args.description.length > 0)
      return args.description;
    if (typeof args.command === "string" && args.command.length > 0)
      return args.command.length > 80
        ? `${args.command.slice(0, 77)}...`
        : args.command;
  }
  if (name === "Read" && typeof args.file_path === "string")
    return `Read ${args.file_path}`;
  if (
    (name === "Edit" || name === "fs_edit_text_file" || name === "edit_file") &&
    (typeof args.file_path === "string" || typeof args.path === "string")
  )
    return `Edit ${args.file_path ?? args.path}`;
  if (name === "Write" && typeof args.file_path === "string")
    return `Write ${args.file_path}`;
  if (name === "Grep" && typeof args.pattern === "string")
    return `Grep: ${args.pattern}`;
  if (name === "Glob" && typeof args.pattern === "string")
    return `Glob: ${args.pattern}`;

  // Server-side tools
  if (name === "project_memory_search" && typeof args.query === "string")
    return `Search memories: ${args.query.length > 50 ? `${args.query.slice(0, 47)}...` : args.query}`;
  if (name === "project_memory_store") return "Store project memory";
  if (name === "project_playbook_store") return "Store playbook";
  if (name === "project_memory_update") return "Update project memory";
  if (name === "project_memory_list") return "List project memories";
  if (name === "project_memory_delete") return "Delete project memory";
  if (name === "cartographer_search" && typeof args.query === "string")
    return `Search codebase: ${args.query.length > 50 ? `${args.query.slice(0, 47)}...` : args.query}`;
  if (name === "cartographer_file_info" && typeof args.file_path === "string")
    return `Inspect ${args.file_path}`;
  if (name === "cartographer_query" && typeof args.entry_points === "string")
    return `Query dependencies: ${args.entry_points.length > 40 ? `${args.entry_points.slice(0, 37)}...` : args.entry_points}`;
  if (name === "read_mimir_logs") return "Read Mimir logs";

  // User memory / profile tools
  if (name === "user_memory_search" && typeof args.query === "string")
    return `Search user memories: ${args.query.length > 50 ? `${args.query.slice(0, 47)}...` : args.query}`;
  if (name === "user_memory_store") return "Store user memory";
  if (name === "user_memory_list") return "List user memories";
  if (name === "user_memory_delete") return "Delete user memory";
  if (name === "user_profile_get") return "Get user profile";
  if (name === "user_profile_add") return "Update user profile";
  if (name === "user_profile_remove") return "Remove user profile entry";

  return name;
};

// ── Location extraction ──

/** Extract file locations from tool call args for editor follow-along. */
export const extractLocations = (
  _name: string,
  args: Record<string, unknown>,
) => {
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

const diffContent = (path: string, oldText: string | null, newText: string) => [
  { type: "diff" as const, path, oldText, newText },
];

const textContent = (text: string) => [
  {
    type: "content" as const,
    content: { type: "text" as const, text },
  },
];

/** Build rich tool call content (diffs, terminal output) for tool results. */
export const buildToolCallContent = (
  name: string,
  args: Record<string, unknown>,
  result: string,
) => {
  // Write operations → diff content
  if (
    name === "fs_write_text_file" ||
    name === "write_text_file" ||
    name === "Write"
  ) {
    const path = args.path ?? args.file_path;
    if (typeof path === "string" && typeof args.content === "string") {
      return diffContent(path, null, args.content);
    }
  }

  // Edit operations → diff content (old_string → new_string)
  if (name === "Edit" || name === "fs_edit_text_file" || name === "edit_file") {
    const path = args.file_path ?? args.path;
    if (typeof path === "string") {
      return diffContent(
        path,
        typeof args.old_string === "string" ? args.old_string : null,
        typeof args.new_string === "string" ? args.new_string : "",
      );
    }
  }

  // Bash / terminal tools → console code block (matches Zed's fallback format).
  // Used when the client doesn't support terminal_output _meta; the terminal
  // path is handled directly in prompt-cc.ts via _meta events.
  if (name === "Bash" || name === "create_terminal" || name === "terminal") {
    const output = result.trim();
    if (output.length > 0) {
      return textContent(`\`\`\`console\n${output}\n\`\`\``);
    }
  }

  // Read tools → surface file contents as text
  if (
    name === "Read" ||
    name === "fs_read_text_file" ||
    name === "read_text_file"
  ) {
    if (result.length > 0) return textContent(result);
  }

  // Search / fetch / memory / log tools → surface results as text
  if (
    name === "Glob" ||
    name === "Grep" ||
    name === "WebFetch" ||
    name === "WebSearch" ||
    name === "project_memory_search" ||
    name === "project_memory_list" ||
    name === "cartographer_search" ||
    name === "cartographer_file_info" ||
    name === "cartographer_query" ||
    name === "read_mimir_logs" ||
    name === "user_memory_search" ||
    name === "user_memory_list" ||
    name === "user_profile_get"
  ) {
    if (result.length > 0) return textContent(result);
  }

  return undefined;
};
