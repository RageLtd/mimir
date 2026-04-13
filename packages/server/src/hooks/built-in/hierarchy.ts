/**
 * Tool hierarchy enforcer — PreToolUse hook.
 *
 * Detects when the model uses a shell command (cat, grep, find, sed, etc.)
 * when a dedicated client-side tool exists for the same operation.
 *
 * Only fires when the dedicated tool is actually available in the current
 * request — if the client doesn't provide a read tool, bash cat is fine.
 */

import type { HookRegistry } from "../registry";
import type { HookContext, PreToolUseResult } from "../types";

// ---------------------------------------------------------------------------
// Substitution rules
// ---------------------------------------------------------------------------

interface Substitution {
  /** Regex to match against the bash command */
  shellPattern: RegExp;
  /** Dedicated tool names that replace this shell command (match any) */
  dedicatedTools: string[];
  /** What the user-friendly name of the operation is */
  operation: string;
}

const SUBSTITUTIONS: Substitution[] = [
  {
    shellPattern: /\b(cat|head|tail)\b/,
    dedicatedTools: ["read", "Read", "read_file", "ReadFile"],
    operation: "reading files",
  },
  {
    shellPattern: /\b(sed|awk)\b/,
    dedicatedTools: ["edit", "Edit", "edit_file", "EditFile", "str_replace"],
    operation: "editing files",
  },
  {
    shellPattern: /\becho\b.*>>|\bcat\b.*<<|\btee\b.*>/,
    dedicatedTools: [
      "write",
      "Write",
      "write_file",
      "WriteFile",
      "create_file",
    ],
    operation: "writing files",
  },
  {
    shellPattern: /\b(find|ls)\s/,
    dedicatedTools: ["glob", "Glob", "list_directory", "ListDirectory"],
    operation: "searching for files",
  },
  {
    shellPattern: /\b(grep|rg|ag)\b/,
    dedicatedTools: ["grep", "Grep", "search", "Search", "search_files"],
    operation: "searching file contents",
  },
];

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

function hierarchyEnforcerHook(ctx: HookContext): PreToolUseResult {
  const command = ctx.args.command ?? ctx.args.cmd;
  if (typeof command !== "string" || !command) {
    return { action: "allow" };
  }

  const available = new Set(ctx.availableTools ?? []);
  if (available.size === 0) {
    return { action: "allow" }; // Can't check without knowing available tools
  }

  for (const sub of SUBSTITUTIONS) {
    if (!sub.shellPattern.test(command)) continue;

    // Check if any dedicated tool for this operation is available
    const dedicatedTool = sub.dedicatedTools.find((t) => available.has(t));
    if (!dedicatedTool) continue;

    // Extract the matched shell command for the message
    const shellMatch = command.match(sub.shellPattern);
    const shellCmd = shellMatch?.[1] ?? shellMatch?.[0] ?? "shell command";

    return {
      action: "allow",
      warning: `Consider using '${dedicatedTool}' tool for ${sub.operation} instead of '${shellCmd}'. Shell commands are a last resort.`,
    };
  }

  return { action: "allow" };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerHierarchyHook(registry: HookRegistry): void {
  registry.onPreToolUse(hierarchyEnforcerHook, {
    pattern: /^(bash|terminal|shell|run_command)$/,
  });
}
