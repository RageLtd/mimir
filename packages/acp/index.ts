import * as acp from "@agentclientprotocol/sdk";
import { runKeysCommand } from "@mimir/plugin-core/keys/cli";
import { createMimirAgent } from "./src/agent";

// Pre-handshake argv dispatch: `mimir-acp keys …` runs the shared key
// ceremonies (MIM-87) so Zed-only users have a working surface with the
// binary they already installed. Anything else falls through to the ACP
// stdio agent.
if (Bun.argv[2] === "keys") {
  process.exit(await runKeysCommand(Bun.argv.slice(3)));
}

const input = Bun.stdin.stream();
const output = new WritableStream<Uint8Array>({
  write(chunk) {
    return new Promise<void>((resolve, reject) => {
      process.stdout.write(chunk, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  },
});

const stream = acp.ndJsonStream(output, input);

// The agent receives the AgentSideConnection in the factory,
// giving it access to readTextFile, writeTextFile, createTerminal,
// and sessionUpdate for client tool forwarding.
new acp.AgentSideConnection((conn) => createMimirAgent(conn), stream);
