/**
 * Client tool definitions and execution — forwards tool calls to the
 * editor via ACP.
 *
 * Used by the server backend path where mimir-acp executes tools on
 * behalf of the model. The CC backend runs its own tools internally.
 *
 * These tool definitions must be included in the manifest sent to the
 * model so it knows it can request file reads, file writes, and terminal
 * execution. When the model calls one, mimir-acp intercepts it and
 * dispatches to executeClientTool, which forwards to the editor.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { errMessage } from "@mimir/plugin-core/util";
import type { ToolDefinition } from "../server-client";
import { createChildLogger, log } from "../utils/log";

const logger = createChildLogger(log, "client-tools");

// ── Client tool definitions (for the model manifest) ──

export const clientToolDefs: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "fs_read_text_file",
      description:
        "Read a text file from the local filesystem. Returns the file contents as a string. Use this to inspect source code, config files, or any text content on disk.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the file to read.",
          },
          line: {
            type: "integer",
            description: "Line number to start reading from (1-indexed).",
          },
          limit: {
            type: "integer",
            description: "Maximum number of lines to read.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fs_write_text_file",
      description:
        "Write content to a text file on the local filesystem. Creates the file if it does not exist. Use this to create or update source code, config files, or any text content on disk.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path of the file to write.",
          },
          content: {
            type: "string",
            description: "The text content to write to the file.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_terminal",
      description:
        "Create a terminal and run a command. Returns the command output. Use this for shell operations like running tests, building projects, or executing CLI commands.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The command to execute.",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "Command-line arguments.",
          },
          cwd: {
            type: "string",
            description: "Working directory for the command.",
          },
        },
        required: ["command"],
      },
    },
  },

  {
    type: "function",
    function: {
      name: "fs_edit_text_file",
      description:
        "Edit a text file on the local filesystem by replacing a specific string. Use this to patch files instead of overwriting them completely.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path of the file to edit.",
          },
          old_string: {
            type: "string",
            description:
              "The exact string to replace. Must match the existing content perfectly.",
          },
          new_string: {
            type: "string",
            description: "The new string to replace it with.",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
];

/** Names of all client tools, including recognized aliases. */
export const clientToolNames = new Set([
  ...clientToolDefs.map((t) => t.function.name),
  "read_text_file",
  "write_text_file",
  "fs_edit_text_file",
  "edit_file",
  "terminal",
]);

/** Options for executing a client tool. */
export type ExecuteClientToolOptions = {
  /** Signal to abort long-running operations (e.g. terminal commands). */
  abortSignal?: AbortSignal;
  /**
   * Callback invoked periodically with the terminal's current output while a
   * `create_terminal` command is running. `isComplete` is true on the final
   * call after the process exits.
   */
  onTerminalOutput?: (
    output: string,
    isComplete: boolean,
  ) => void | Promise<void>;
};

// ── Client tool execution ──

export const executeClientTool = async (
  name: string,
  args: Record<string, unknown>,
  sessionId: string,
  conn: acp.AgentSideConnection,
  options?: ExecuteClientToolOptions,
) => {
  if (name === "fs_read_text_file" || name === "read_text_file") {
    if (typeof args.path !== "string") return `${name}: missing path arg`;
    const result = await conn.readTextFile({
      sessionId,
      path: args.path,
      line: typeof args.line === "number" ? args.line : null,
      limit: typeof args.limit === "number" ? args.limit : null,
    });
    return result.content;
  }

  if (name === "fs_write_text_file" || name === "write_text_file") {
    if (typeof args.path !== "string") return `${name}: missing path arg`;
    if (typeof args.content !== "string") return `${name}: missing content arg`;
    await conn.writeTextFile({
      sessionId,
      path: args.path,
      content: args.content,
    });
    return "File written successfully.";
  }

  if (name === "fs_edit_text_file" || name === "edit_file" || name === "Edit") {
    if (typeof args.path !== "string") return `${name}: missing path arg`;
    if (typeof args.old_string !== "string")
      return `${name}: missing old_string arg`;
    if (typeof args.new_string !== "string")
      return `${name}: missing new_string arg`;

    const readResult = await conn.readTextFile({
      sessionId,
      path: args.path,
      line: null,
      limit: null,
    });

    const content = readResult.content;
    const occurrences = content.split(args.old_string).length - 1;

    if (occurrences === 0) {
      return "Error: old_string not found in file. The string must match exactly.";
    }
    if (occurrences > 1) {
      return "Error: old_string matches multiple times in file. Please provide a more unique snippet to replace.";
    }

    const newContent = content.replace(args.old_string, args.new_string);

    await conn.writeTextFile({
      sessionId,
      path: args.path,
      content: newContent,
    });
    return "File edited successfully.";
  }

  if (name === "create_terminal" || name === "terminal") {
    if (typeof args.command !== "string") return `${name}: missing command arg`;
    const handle = await conn.createTerminal({
      sessionId,
      command: args.command,
      args: Array.isArray(args.args)
        ? args.args.filter((a) => typeof a === "string")
        : undefined,
      cwd: typeof args.cwd === "string" ? args.cwd : null,
    });

    // If a streaming callback was provided, poll currentOutput while waiting.
    if (options?.onTerminalOutput) {
      let done = false;
      let lastOutput = "";
      const exitPromise = handle.waitForExit().finally(() => {
        done = true;
      });

      const pollPromise = (async () => {
        while (!done) {
          if (options.abortSignal?.aborted) {
            handle.kill().catch((err) => {
              logger.debug("Terminal kill failed:", errMessage(err));
            });
            break;
          }
          await new Promise((r) => setTimeout(r, 250));
          if (done) break;
          const current = await handle.currentOutput();
          if (current.output.length > lastOutput.length) {
            lastOutput = current.output;
            await options.onTerminalOutput?.(current.output, false);
          }
        }
      })();

      await Promise.race([exitPromise, pollPromise]);
      await exitPromise; // ensure terminal has finished
      const final = await handle.currentOutput();
      await handle.release();
      await options.onTerminalOutput(final.output, true);
      return final.output;
    }

    // No streaming callback — simple blocking wait with abort support.
    if (options?.abortSignal) {
      const abortPromise = new Promise<never>((_, reject) => {
        const onAbort = () => {
          handle.kill().catch((err) => {
            logger.debug("Terminal kill failed:", errMessage(err));
          });
          reject(new Error("Aborted"));
        };
        options.abortSignal?.addEventListener("abort", onAbort, { once: true });
      });
      await Promise.race([handle.waitForExit(), abortPromise]);
    } else {
      await handle.waitForExit();
    }
    const output = await handle.currentOutput();
    await handle.release();
    return output.output;
  }

  return `Unknown client tool: ${name}`;
};
