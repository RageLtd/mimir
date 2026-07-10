/**
 * Codex → CC tool-shape adapter.
 *
 * Codex's hook payloads (verified on 0.144.0, fixture at
 * test-fixtures/hook-payloads.jsonl) name the shell tool "Bash" with
 * tool_input.command — identical to Claude Code, so command-based rule
 * detectors work unchanged. Edits differ: everything funnels through
 * "apply_patch" whose tool_input.command is a patch document
 * ("*** Update File: <path>" / "*** Add File: <path>" headers, one per
 * touched file). There is no Read tool at all — file reads happen as
 * Bash commands (sed/cat/head/tail).
 *
 * This module translates those shapes into what the shared rules engine
 * and the reindex/file-context hooks already understand:
 *   - normalizeToolCalls: apply_patch → one Edit/Write-shaped call per
 *     touched file (rules engine sees CC-native tool names).
 *   - editedFilePaths:   paths written by an apply_patch, for reindex.
 *   - readFilePaths:     conservative single-file parse of Bash read
 *     commands, for file-context injection. Missing an exotic read is
 *     benign — the hook simply doesn't inject.
 */

export const APPLY_PATCH_TOOL = "apply_patch";
export const BASH_TOOL = "Bash";

type PatchFileOp = {
  readonly kind: "update" | "add" | "delete";
  readonly path: string;
};

const PATCH_HEADER = /^\*\*\* (Update|Add|Delete) File: (.+)$/;

/**
 * Extract per-file operations from an apply_patch document. Tolerates
 * arbitrary hunk content between headers; only header lines are parsed.
 */
export const parsePatchOps = (patch: string) => {
  const ops: PatchFileOp[] = [];
  for (const line of patch.split("\n")) {
    const match = PATCH_HEADER.exec(line);
    if (!match) continue;
    const kind = match[1]?.toLowerCase() as PatchFileOp["kind"] | undefined;
    const path = match[2]?.trim();
    if (kind && path && path.length > 0) ops.push({ kind, path });
  }
  return ops;
};

const commandOf = (toolInput: unknown) => {
  if (!toolInput || typeof toolInput !== "object") return null;
  const command = (toolInput as Record<string, unknown>).command;
  return typeof command === "string" && command.length > 0 ? command : null;
};

export type NormalizedToolCall = {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
};

/**
 * Normalise one Codex tool call into CC-equivalent calls for the rules
 * engine. apply_patch fans out to one Edit/Write per touched file
 * (delete has no CC analog the rules care about — skipped); everything
 * else passes through unchanged, which is already CC-shaped for Bash.
 */
export const normalizeToolCalls = (
  toolName: string,
  toolInput: unknown,
): NormalizedToolCall[] => {
  if (toolName !== APPLY_PATCH_TOOL) {
    return [
      {
        toolName,
        toolInput:
          toolInput && typeof toolInput === "object"
            ? (toolInput as Record<string, unknown>)
            : {},
      },
    ];
  }

  const patch = commandOf(toolInput);
  if (!patch) return [];

  return parsePatchOps(patch).flatMap((op) => {
    if (op.kind === "delete") return [];
    return [
      {
        // Update ≈ Edit (existing file), Add ≈ Write (new file) — the
        // distinction matters to rules like file-length that read the
        // on-disk file.
        toolName: op.kind === "update" ? "Edit" : "Write",
        toolInput: { file_path: op.path },
      },
    ];
  });
};

/** File paths written by this tool call (reindex trigger set). */
export const editedFilePaths = (toolName: string, toolInput: unknown) => {
  if (toolName !== APPLY_PATCH_TOOL) return [] as string[];
  const patch = commandOf(toolInput);
  if (!patch) return [] as string[];
  return parsePatchOps(patch)
    .filter((op) => op.kind !== "delete")
    .map((op) => op.path);
};

// Conservative single-file read commands. Compound commands (pipes,
// `&&`, `;`, redirection) are deliberately not matched — a missed
// file-context injection is benign, a wrong one is noise.
const READ_COMMAND_PATTERNS = [
  // cat [flags] <file>
  /^cat(?:\s+-[A-Za-z]+)*\s+([^\s|;&<>'"$`\\]+)$/,
  // sed -n '<range>p' <file>  (Codex's default read idiom)
  /^sed\s+-n\s+'[^']*p'\s+([^\s|;&<>'"$`\\]+)$/,
  // head/tail [flags, incl. detached values like `-n 20`] <file>
  /^(?:head|tail)(?:\s+-{1,2}[A-Za-z0-9=]+(?:\s+\d+)?)*\s+([^\s|;&<>'"$`\\]+)$/,
];

/**
 * File path a Bash command is reading, when it is a simple single-file
 * read. Null for anything compound or unrecognised.
 */
export const readFilePath = (toolName: string, toolInput: unknown) => {
  if (toolName !== BASH_TOOL) return null;
  const command = commandOf(toolInput);
  if (!command) return null;
  const trimmed = command.trim();
  for (const pattern of READ_COMMAND_PATTERNS) {
    const match = pattern.exec(trimmed);
    const path = match?.[1];
    if (path && path.length > 0) return path;
  }
  return null;
};
