/**
 * Mechanical detector for the "File Length" rule.
 * Paired with file-length.md. Flags edits that produce (or enlarge)
 * files past the 500-line cap.
 *
 * Scope: the paired .md frontmatter declares which file types apply.
 * This detector handles Write / Edit / MultiEdit by reading the target
 * file from disk (when present) and computing the post-edit line count.
 */

import {
  getToolInput,
  type RuleDetectionInput,
  type Violation,
} from "../detection-helpers";

const LIMIT = 500;

const countLines = (s: string) => s.split("\n").length;

const readFile = async (path: string) => {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) return null;
  return file.text();
};

const projectedLinesForWrite = (toolInput: Record<string, unknown>) =>
  typeof toolInput.content === "string" ? countLines(toolInput.content) : null;

const projectedLinesForEdit = async (
  filePath: string,
  toolInput: Record<string, unknown>,
) => {
  const oldString = toolInput.old_string;
  const newString = toolInput.new_string;
  if (typeof oldString !== "string" || typeof newString !== "string")
    return null;
  const current = await readFile(filePath);
  if (current === null || !current.includes(oldString)) return null;
  return countLines(current.replace(oldString, newString));
};

const projectedLinesForMultiEdit = async (
  filePath: string,
  toolInput: Record<string, unknown>,
) => {
  if (!Array.isArray(toolInput.edits)) return null;
  let buf = await readFile(filePath);
  if (buf === null) return null;
  for (const e of toolInput.edits) {
    if (!e || typeof e !== "object") return null;
    const oldString = (e as { old_string?: unknown }).old_string;
    const newString = (e as { new_string?: unknown }).new_string;
    if (typeof oldString !== "string" || typeof newString !== "string")
      return null;
    if (!buf.includes(oldString)) return null;
    buf = buf.replace(oldString, newString);
  }
  return countLines(buf);
};

export default async (input: RuleDetectionInput) => {
  const filePath = input.filePath;
  if (!filePath) return [];
  const toolName =
    typeof input.hookEvent.tool_name === "string"
      ? input.hookEvent.tool_name
      : "";
  const toolInput = getToolInput(input);

  let finalLines: number | null = null;
  if (toolName === "Write") {
    finalLines = projectedLinesForWrite(toolInput);
  } else if (toolName === "Edit") {
    finalLines = await projectedLinesForEdit(filePath, toolInput);
  } else if (toolName === "MultiEdit") {
    finalLines = await projectedLinesForMultiEdit(filePath, toolInput);
  }

  if (finalLines === null || finalLines <= LIMIT) return [];

  const violations: Violation[] = [
    {
      message: `File would be ${finalLines} lines after this edit (limit: ${LIMIT}). See the paired rule.`,
    },
  ];
  return violations;
};
