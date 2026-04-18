/**
 * Mechanical detector for the "File Length" rule.
 * Paired with file-length.md. Flags edits that produce (or enlarge) files
 * past the 500-line cap.
 *
 * Three modes:
 *   - Write: count newlines in `content` — final file length is known.
 *   - Edit: read the target from disk, replace `old_string` with
 *     `new_string`, count lines of the result. If the file doesn't exist
 *     yet (first Write via Edit isn't possible, but guard anyway), skip.
 *   - MultiEdit: apply each edit sequentially on the in-memory buffer,
 *     then count.
 *
 * Async detector — reads from disk. The rule-hooks runner awaits.
 */

interface DetectInput {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly filePath?: string;
  readonly content?: string;
}

const LIMIT = 500;

const countLines = (s: string) => s.split("\n").length;

const shouldScan = (filePath?: string) => {
  if (!filePath) return false;
  // Broadly applicable: TS, JS, Rust, Go, Python. Not binary files.
  return /\.(ts|tsx|mts|mjs|js|jsx|rs|go|py)$/.test(filePath);
};

const readFile = async (path: string) => {
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) return null;
  return file.text();
};

const projectedLengthForEdit = async (
  filePath: string,
  oldString: string,
  newString: string,
) => {
  const current = await readFile(filePath);
  if (current === null) return null;
  // Conservative: only replace if old_string actually appears. If it
  // doesn't, the edit will fail — skip flagging.
  if (!current.includes(oldString)) return null;
  const after = current.replace(oldString, newString);
  return countLines(after);
};

const projectedLengthForMultiEdit = async (
  filePath: string,
  edits: ReadonlyArray<{ old_string: string; new_string: string }>,
) => {
  let buf = await readFile(filePath);
  if (buf === null) return null;
  for (const edit of edits) {
    if (!buf.includes(edit.old_string)) return null;
    buf = buf.replace(edit.old_string, edit.new_string);
  }
  return countLines(buf);
};

const extractMultiEdits = (toolInput: Record<string, unknown>) => {
  if (!Array.isArray(toolInput.edits)) return null;
  const out: Array<{ old_string: string; new_string: string }> = [];
  for (const e of toolInput.edits) {
    if (!e || typeof e !== "object") return null;
    const old_string = (e as { old_string?: unknown }).old_string;
    const new_string = (e as { new_string?: unknown }).new_string;
    if (typeof old_string !== "string" || typeof new_string !== "string") {
      return null;
    }
    out.push({ old_string, new_string });
  }
  return out;
};

const detect = async (input: DetectInput) => {
  if (!shouldScan(input.filePath)) return [];
  const filePath = input.filePath;
  if (!filePath) return [];

  let finalLines: number | null = null;

  if (input.toolName === "Write") {
    if (typeof input.content !== "string") return [];
    finalLines = countLines(input.content);
  } else if (input.toolName === "Edit") {
    const oldString = input.toolInput.old_string;
    const newString = input.toolInput.new_string;
    if (typeof oldString !== "string" || typeof newString !== "string")
      return [];
    finalLines = await projectedLengthForEdit(filePath, oldString, newString);
  } else if (input.toolName === "MultiEdit") {
    const edits = extractMultiEdits(input.toolInput);
    if (!edits) return [];
    finalLines = await projectedLengthForMultiEdit(filePath, edits);
  } else {
    return [];
  }

  if (finalLines === null) return [];
  if (finalLines <= LIMIT) return [];

  return [
    {
      message: `File would be ${finalLines} lines after this edit (limit: ${LIMIT}). See the paired rule.`,
    },
  ];
};

export default detect;
