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
import type { ToolDefinition } from "../server-client";
import { errMessage } from "../util";
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
];

/** Names of all client tools, including recognized aliases. */
export const clientToolNames = new Set([
  ...clientToolDefs.map((t) => t.function.name),
  "read_text_file",
  "write_text_file",
  "terminal",
]);

// ── Client tool execution ──

export const executeClientTool = async (
  name: string,
  args: Record<string, unknown>,
  sessionId: string,
  conn: acp.AgentSideConnection,
) => {
  try {
    if (name === "fs_read_text_file" || name === "read_text_file") {
      const result = await conn.readTextFile({
        sessionId,
        path: args.path as string,
        line: (args.line as number | undefined) ?? null,
        limit: (args.limit as number | undefined) ?? null,
      });
      return result.content;
    }

    if (name === "fs_write_text_file" || name === "write_text_file") {
      await conn.writeTextFile({
        sessionId,
        path: args.path as string,
        content: args.content as string,
      });
      return "File written successfully.";
    }

    if (name === "create_terminal" || name === "terminal") {
      const handle = await conn.createTerminal({
        sessionId,
        command: args.command as string,
        args: args.args as string[] | undefined,
        cwd: (args.cwd as string | undefined) ?? null,
      });
      await handle.waitForExit();
      const output = await handle.currentOutput();
      await handle.release();
      return output.output;
    }

    return `Unknown client tool: ${name}`;
  } catch (err) {
    const msg = errMessage(err);
    logger.error("Client tool error:", msg);
    return `Error executing ${name}: ${msg}`;
  }
};
