/**
 * Client tool execution — forwards tool calls to the editor via ACP.
 *
 * Used by the server backend path where mimir-acp executes tools on
 * behalf of the model. The CC backend runs its own tools internally.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { createChildLogger, log } from "../utils/log";

const logger = createChildLogger(log, "client-tools");

export const executeClientTool = async (
  name: string,
  args: Record<string, unknown>,
  sessionId: string,
  conn: acp.AgentSideConnection,
): Promise<string> => {
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
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("Client tool error:", msg);
    return `Error executing ${name}: ${msg}`;
  }
};
