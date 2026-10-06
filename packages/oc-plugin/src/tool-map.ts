import { resolve } from "node:path";
import { toolInput } from "./v2-tool-results";

const call = (toolName: string, toolInput: Record<string, unknown>) => ({
  toolName,
  toolInput,
});

const FILE_HEADER = /^\*\*\* (Update|Add|Delete) File: (.+)$/;

/**
 * Patch hunks are substring edits, not unified-diff line-number edits. Keep
 * context on both sides, but never expose removed lines as incoming content.
 * Joining without a terminal newline works for both EOF and interior matches;
 * the patch format cannot tell us the existing file's final-newline state.
 */
const patchEdits = (lines: string[]) => {
  const edits: { old_string: string; new_string: string }[] = [];
  let oldLines: string[] = [];
  let newLines: string[] = [];
  const flush = () => {
    if (oldLines.length || newLines.length) {
      edits.push({
        old_string: oldLines.join("\n"),
        new_string: newLines.join("\n"),
      });
    }
    oldLines = [];
    newLines = [];
  };
  for (const line of lines) {
    if (line === "@@" || line.startsWith("@@ ")) {
      flush();
    } else if (line.startsWith("-")) {
      oldLines.push(line.slice(1));
    } else if (line.startsWith("+")) {
      newLines.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    }
  }
  flush();
  return edits;
};

/**
 * One canonical call per affected file, in patch order. Moves emit a source
 * deletion before the destination edit so neither path bypasses scopes/guards.
 * Destination edits carry projection_source_path: full-file builtins must read
 * that source rather than file_path before applying hunks. This synchronous
 * adapter performs no disk reads; consumers ignoring the field cannot project
 * the destination's unchanged source content (including hunkless moves).
 * Deletes carry empty content so file_path-only conditions still run; deleted
 * metadata lets full-file builtins skip a removal rather than inspect old size.
 * This is
 * an enforcement adapter, not an executable reconstruction of a deletion.
 */
const patchCalls = (patch: string) => {
  const calls: ReturnType<typeof call>[] = [];
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const header = FILE_HEADER.exec(lines[index] ?? "");
    const path = header?.[2]?.trim();
    if (!header || !path) continue;
    const body: string[] = [];
    while (index + 1 < lines.length) {
      const next = lines[index + 1] ?? "";
      if (FILE_HEADER.test(next) || next === "*** End Patch") break;
      body.push(next);
      index++;
    }
    if (header[1] === "Add") {
      const content = body
        .filter((line) => line.startsWith("+"))
        .map((line) => line.slice(1));
      calls.push(
        call("Write", {
          file_path: path,
          content: content.length ? `${content.join("\n")}\n` : "",
        }),
      );
    } else if (header[1] === "Delete") {
      calls.push(
        call("Edit", {
          file_path: path,
          old_string: "",
          new_string: "",
          deleted: true,
        }),
      );
    } else {
      const destination = body
        .find((line) => line.startsWith("*** Move to: "))
        ?.slice("*** Move to: ".length)
        .trim();
      if (destination) {
        calls.push(
          call("Edit", {
            file_path: path,
            old_string: "",
            new_string: "",
            deleted: true,
          }),
        );
      }
      calls.push(
        call("MultiEdit", {
          file_path: destination || path,
          ...(destination ? { projection_source_path: path } : {}),
          edits: patchEdits(body),
        }),
      );
    }
  }
  return calls;
};

/** Native V2 inputs → shared rule-engine (Claude Code) vocabulary. */
const nativeCalls = (toolName: string, input: unknown) => {
  const args = toolInput(input);
  switch (toolName) {
    case "shell":
      return [call("Bash", { command: args.command, cwd: args.workdir })];
    case "edit":
      return [
        call("Edit", {
          file_path: args.path,
          old_string: args.oldString,
          new_string: args.newString,
          replace_all: args.replaceAll,
        }),
      ];
    case "write":
      return [call("Write", { file_path: args.path, content: args.content })];
    case "read":
      return [call("Read", { file_path: args.path })];
    case "patch":
      return typeof args.patchText === "string"
        ? patchCalls(args.patchText)
        : [];
    default:
      return [call(toolName, args)];
  }
};

/** Resolve native relative paths from the session location, not project root. */
export const normalizeToolCalls = (
  toolName: string,
  input: unknown,
  directory?: string,
) => {
  const calls = nativeCalls(toolName, input);
  if (directory === undefined) return calls;
  return calls.map(({ toolName, toolInput }) =>
    call(toolName, {
      ...toolInput,
      ...(typeof toolInput.file_path === "string"
        ? { file_path: resolve(directory, toolInput.file_path) }
        : {}),
      ...(typeof toolInput.projection_source_path === "string"
        ? {
            projection_source_path: resolve(
              directory,
              toolInput.projection_source_path,
            ),
          }
        : {}),
      ...(toolName === "Bash"
        ? {
            cwd: resolve(
              directory,
              typeof toolInput.cwd === "string" ? toolInput.cwd : ".",
            ),
          }
        : {}),
    }),
  );
};
